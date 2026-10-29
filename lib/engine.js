// Streaming ASR engine.
//
// Two modes, picked by what is on disk:
//  * hybrid      - a streaming transducer produces the live partial text, and
//                  SenseVoice re-decodes every finished utterance (punctuation,
//                  better Chinese accuracy).
//  * sensevoice  - no streaming model: SenseVoice re-decodes the growing audio
//                  window every ~700 ms to act as a pseudo-streaming partial,
//                  and an energy-based silence detector closes utterances.

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
let sherpaModule = null

function sherpa() {
  if (!sherpaModule) sherpaModule = require('sherpa-onnx-node')
  return sherpaModule
}

const SAMPLE_RATE = 16000
const MAX_SEGMENT_SECONDS = 25
const PARTIAL_WINDOW_SECONDS = 10
const PARTIAL_INTERVAL_MS = 700
const SILENCE_RMS = 0.006
const SILENCE_ENDPOINT_MS = 1100

const STREAM_FILES = [
  'streaming/encoder-epoch-99-avg-1.int8.onnx',
  'streaming/decoder-epoch-99-avg-1.int8.onnx',
  'streaming/joiner-epoch-99-avg-1.int8.onnx',
  'streaming/tokens.txt',
]

function toFloat32(pcm) {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  const count = buf.length >> 1
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

function concatSamples(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function rmsOf(samples) {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.ceil(samples.length / 4))
}

/** SenseVoice returns `<|zh|><|NEUTRAL|><|Speech|><|woitn|>text` style tags. */
function stripTags(text) {
  return String(text || '').replace(/<\|[^|]*\|>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Join utterance pieces: no space between CJK, one space between latin words. */
export function joinSegments(texts) {
  let out = ''
  for (const raw of texts) {
    const t = String(raw || '').trim()
    if (!t) continue
    if (!out) { out = t; continue }
    const a = out.codePointAt(out.length - 1)
    const b = t.codePointAt(0)
    const cjk = (cp) => cp >= 0x2e80 && cp <= 0x9fff
    out += (cjk(a) || cjk(b)) ? t : ` ${t}`
  }
  return out
}

export class HybridEngine {
  constructor(options) {
    this.dir = options.dir
    this.threads = options.threads || 2
    this.useSenseVoice = options.senseVoice !== false
    this.online = null
    this.offline = null
    this.loaded = false
    this.loading = null
    this.error = ''
    this.mode = 'sensevoice'
    this.info = { streaming: false, senseVoice: false, mode: 'sensevoice' }
    this.warn = options.warn || (() => {})
  }

  file(rel) { return path.join(this.dir, rel) }

  hasStreaming() {
    return STREAM_FILES.every(f => existsSync(this.file(f)))
  }

  init() {
    if (this.loaded) return Promise.resolve(this)
    if (this.loading) return this.loading
    this.loading = (async () => {
      const s = sherpa()
      const started = Date.now()

      if (this.hasStreaming()) {
        this.online = new s.OnlineRecognizer({
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: this.file('streaming/encoder-epoch-99-avg-1.int8.onnx'),
              decoder: this.file('streaming/decoder-epoch-99-avg-1.int8.onnx'),
              joiner: this.file('streaming/joiner-epoch-99-avg-1.int8.onnx'),
            },
            tokens: this.file('streaming/tokens.txt'),
            numThreads: this.threads,
            provider: 'cpu',
            debug: 0,
            modelType: 'zipformer',
          },
          decodingMethod: 'greedy_search',
          maxActivePaths: 4,
          enableEndpoint: true,
          rule1MinTrailingSilence: 2.4,
          rule2MinTrailingSilence: 1.2,
          rule3MinUtteranceLength: 20,
        })
        this.info.streaming = true
        this.mode = 'hybrid'
      } else {
        this.warn('streaming model not found; running SenseVoice in incremental mode')
      }

      if (this.useSenseVoice) {
        const config = {
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            senseVoice: {
              model: this.file('sensevoice/model.int8.onnx'),
              language: 'auto',
              useInverseTextNormalization: 1,
            },
            tokens: this.file('sensevoice/tokens.txt'),
            numThreads: this.threads,
            provider: 'cpu',
            debug: 0,
          },
          decodingMethod: 'greedy_search',
        }
        try {
          this.offline = typeof s.OfflineRecognizer.createAsync === 'function'
            ? await s.OfflineRecognizer.createAsync(config)
            : new s.OfflineRecognizer(config)
          this.info.senseVoice = !!this.offline
        } catch (err) {
          this.offline = null
          this.info.senseVoice = false
          this.warn(`SenseVoice unavailable, falling back to streaming text: ${err && err.message}`)
        }
      }

      if (!this.online && !this.offline) throw new Error('no usable recognizer (models missing)')
      this.info.mode = this.mode
      this.loaded = true
      this.info.loadMs = Date.now() - started
      this.warn(`engine ready in ${this.info.loadMs}ms (mode=${this.mode}, sensevoice=${this.info.senseVoice})`)
      return this
    })().catch((err) => {
      this.error = String((err && err.message) || err)
      this.loading = null
      throw err
    })
    return this.loading
  }

  createSession() {
    return {
      stream: this.online ? this.online.createStream() : null,
      resampler: null,
      sampleRate: SAMPLE_RATE,
      window: [],          // audio of the utterance in progress
      chunks: [],          // full audio of the session
      segments: [],
      partial: '',
      silenceMs: 0,
      voicedMs: 0,
      decoding: false,
      lastDecodeAt: 0,
      startedAt: Date.now(),
    }
  }

  /** Normalize a raw PCM16 chunk to 16 kHz float samples. */
  normalize(session, pcm16, sampleRate) {
    const rate = Number(sampleRate) || SAMPLE_RATE
    let samples = toFloat32(pcm16)
    if (rate !== SAMPLE_RATE) {
      const s = sherpa()
      if (!session.resampler || session.resamplerRate !== rate) {
        session.resampler = new s.LinearResampler(rate, SAMPLE_RATE)
        session.resamplerRate = rate
      }
      samples = session.resampler.resample(samples)
    }
    return samples
  }

  windowSeconds(session) {
    let n = 0
    for (const c of session.window) n += c.length
    return n / SAMPLE_RATE
  }

  /** Feed one chunk; returns the live partial text and whether an endpoint fired. */
  feed(session, pcm16, sampleRate) {
    const samples = this.normalize(session, pcm16, sampleRate)
    if (samples.length === 0) return { partial: session.partial, endpoint: false, duration: 0 }
    const ms = (samples.length / SAMPLE_RATE) * 1000
    session.chunks.push(samples)
    session.window.push(samples)
    if (this.windowSeconds(session) > PARTIAL_WINDOW_SECONDS) {
      // keep the window bounded; drop the oldest audio
      while (this.windowSeconds(session) > PARTIAL_WINDOW_SECONDS && session.window.length > 1) session.window.shift()
    }

    let endpoint = false
    if (this.online) {
      session.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      while (this.online.isReady(session.stream)) this.online.decode(session.stream)
      const result = this.online.getResult(session.stream)
      session.partial = String(result.text || '').trim()
      endpoint = this.online.isEndpoint(session.stream)
      if (!endpoint && this.windowSeconds(session) >= MAX_SEGMENT_SECONDS) endpoint = true
    } else {
      const rms = rmsOf(samples)
      if (rms < SILENCE_RMS) session.silenceMs += ms
      else { session.silenceMs = 0; session.voicedMs += ms }
      const now = Date.now()
      if (this.offline && !session.decoding && session.silenceMs === 0 && now - session.lastDecodeAt >= PARTIAL_INTERVAL_MS) {
        const audio = concatSamples(session.window)
        if (audio.length >= SAMPLE_RATE * 0.6) {
          session.decoding = true
          session.lastDecodeAt = now
          this.decodeOffline(audio)
            .then(text => { if (text) session.partial = text })
            .catch(() => {})
            .finally(() => { session.decoding = false })
        }
      }
      if (session.silenceMs >= SILENCE_ENDPOINT_MS && session.voicedMs >= 300) endpoint = true
      if (this.windowSeconds(session) >= MAX_SEGMENT_SECONDS) endpoint = true
    }

    return { partial: session.partial, endpoint, duration: session.chunks.length ? this.windowSeconds(session) : 0 }
  }

  /** Close the current utterance and return the finalized segment. */
  async finalizeSegment(session) {
    const rawText = session.partial.trim()
    const audio = session.window.length ? concatSamples(session.window) : new Float32Array(0)
    const voicedMs = session.voicedMs || 0
    session.window = []
    session.partial = ''
    session.silenceMs = 0
    session.voicedMs = 0
    if (this.online) this.online.reset(session.stream)
    if (!rawText && audio.length < SAMPLE_RATE * 0.2) return null
    // Silence (or near-silence) hallucinates text on every ASR model: drop it.
    if (audio.length && (rmsOf(audio) < 0.004 || (this.mode === 'sensevoice' && voicedMs > 0 && voicedMs < 250))) {
      return null
    }

    let text = rawText
    let refined = false
    if (this.offline && audio.length >= SAMPLE_RATE * 0.3) {
      try {
        const decoded = await this.decodeOffline(audio)
        if (decoded) { text = decoded; refined = true }
      } catch (err) {
        this.warn(`offline decode failed: ${err && err.message}`)
      }
    }
    if (!text) return null
    const segment = { text, refined, seconds: +(audio.length / SAMPLE_RATE).toFixed(2) }
    session.segments.push(segment)
    return segment
  }

  async decodeOffline(samples) {
    if (!this.offline) return ''
    const stream = this.offline.createStream()
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
    const result = await this.offline.decodeAsync(stream)
    return stripTags(result.text)
  }

  async finish(session) {
    if (this.online && session.stream) {
      session.stream.inputFinished()
      while (this.online.isReady(session.stream)) this.online.decode(session.stream)
      const last = this.online.getResult(session.stream)
      session.partial = String(last.text || '').trim()
    } else if (this.offline && session.window.length) {
      try {
        const decoded = await this.decodeOffline(concatSamples(session.window))
        if (decoded) session.partial = decoded
      } catch { /* ignore */ }
    }
    if (session.partial || session.window.length) await this.finalizeSegment(session)
    return {
      text: joinSegments(session.segments.map(s => s.text)),
      segments: session.segments,
      seconds: +(session.chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE).toFixed(2),
    }
  }
}
