// dsh-voice-realtime — host half.
// Serves the real-time transcription endpoints the composer microphone uses:
//   GET  /dsh-voice/status            engine + model readiness
//   POST /dsh-voice/models/download   fetch the sherpa-onnx models (hf-mirror)
//   POST /dsh-voice/session           open a recognition session
//   POST /dsh-voice/audio?id=..&sr=.. raw PCM16LE mono chunk -> live partial text
//   POST /dsh-voice/finish?id=..      close the session -> final text
//   POST /dsh-voice/cancel?id=..      drop the session

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HybridEngine, joinSegments } from './engine.js'
import {
  MODEL_FILES, downloadStatus, downloadTarget, findReadyRoot, report, startDownload,
} from './models.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = '/dsh-voice'
const MAX_CHUNK_BYTES = 2 * 1024 * 1024
const SESSION_IDLE_MS = 3 * 60 * 1000

export const name = 'dsh-voice-realtime'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

export function apply(root, config = {}) {
  const engineOptions = { threads: config.threads || 2, senseVoice: config.senseVoice !== false }
  const sessions = new Map()
  let engine = null
  let engineError = ''
  let lastCleanup = Date.now()

  const warn = (message) => {
    try { console.log(`[dsh-voice] ${message}`) } catch {}
  }

  /** Where models live (or would be downloaded to). */
  async function resolveModelsDir() {
    const ready = await findReadyRoot({ ...config, packageRoot: PACKAGE_ROOT })
    if (ready) return ready.dir
    return downloadTarget({ ...config, packageRoot: PACKAGE_ROOT }, null)
  }

  async function ensureEngine() {
    if (engine?.loaded) return engine
    if (engine && !engineError && engine.loading) {
      await engine.loading.catch(() => {})
      if (engine.loaded) return engine
    }
    const dir = await resolveModelsDir()
    const info = await report(dir)
    if (!info.ready) {
      engineError = `models missing in ${dir}`
      const err = new Error(engineError)
      err.code = 'models-missing'
      err.missing = info.missing.map(m => m.rel)
      throw err
    }
    if (!engine || engine.dir !== dir) engine = new HybridEngine({ ...engineOptions, dir, warn })
    try {
      await engine.init()
      engineError = ''
    } catch (err) {
      engineError = String((err && err.message) || err)
      throw err
    }
    return engine
  }

  function cleanup() {
    const now = Date.now()
    if (now - lastCleanup < 30000) return
    lastCleanup = now
    for (const [id, entry] of sessions) {
      if (now - entry.touchedAt > SESSION_IDLE_MS) sessions.delete(id)
    }
  }

  function statusPayload(dir, modelsReport) {
    const dl = downloadStatus()
    const required = MODEL_FILES.filter(f => !f.optional)
    const presentBytes = (modelsReport?.present || []).reduce((n, f) => n + f.size, 0) + (dl.active ? dl.bytes : 0)
    return {
      ok: true,
      models: {
        dir,
        ready: !!modelsReport?.ready,
        missing: (modelsReport?.missing || []).filter(m => !m.optional).map(m => m.rel),
        optionalMissing: (modelsReport?.missing || []).filter(m => m.optional).map(m => m.rel),
        presentBytes,
        totalBytes: required.reduce((n, f) => n + f.size, 0),
      },
      download: dl,
      engine: {
        loaded: !!engine?.loaded,
        loading: !!engine?.loading && !engine?.loaded,
        error: engineError,
        info: engine?.info || null,
      },
      sessions: sessions.size,
    }
  }

  root.inject(['webServer'], (ctx) => {
    const fence = () => {
      try { return ctx.connection?.requestRejection?.bind(ctx.connection) ?? null } catch { return null }
    }

    async function route(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const op = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')
      const check = fence()
      if (check) {
        let code
        try { code = check(req) } catch { code = 403 }
        if (code) { sendJson(res, typeof code === 'number' ? code : 403, { ok: false, error: 'rejected' }); return }
      }
      cleanup()

      try {
        if (op === 'status' || op === '') {
          const dir = await resolveModelsDir()
          const info = await report(dir)
          sendJson(res, 200, statusPayload(dir, info))
          return
        }

        if (op === 'models/download') {
          const dir = await resolveModelsDir()
          const state = startDownload(dir)
          sendJson(res, 202, { ok: true, dir, download: state })
          return
        }

        if (op === 'engine/reload') {
          // Re-read the model directory (e.g. after the streaming model lands)
          // without restarting the whole app.
          engine = null
          engineError = ''
          const eng = await ensureEngine()
          sendJson(res, 200, { ok: true, info: eng.info })
          return
        }

        if (op === 'session') {
          const eng = await ensureEngine()
          const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
          sessions.set(id, { session: eng.createSession(), touchedAt: Date.now() })
          sendJson(res, 200, { ok: true, id, engine: eng.info })
          return
        }

        if (op === 'audio') {
          const id = url.searchParams.get('id') || ''
          const entry = sessions.get(id)
          if (!entry) { sendJson(res, 404, { ok: false, error: 'unknown session' }); return }
          entry.touchedAt = Date.now()
          const body = await readBody(req, MAX_CHUNK_BYTES)
          if (!body.length) { sendJson(res, 200, { ok: true, partial: entry.session.partial }); return }
          const sampleRate = Number(url.searchParams.get('sr')) || 16000
          const eng = await ensureEngine()
          const result = eng.feed(entry.session, body, sampleRate)
          let finalSegment = null
          if (result.endpoint) {
            try { finalSegment = await eng.finalizeSegment(entry.session) } catch (err) { warn(`finalize failed: ${err.message}`) }
          }
          sendJson(res, 200, {
            ok: true,
            partial: entry.session.partial,
            segments: entry.session.segments.map(s => s.text),
            text: joinSegments(entry.session.segments.map(s => s.text)),
            endpoint: result.endpoint,
            finalSegment: finalSegment?.text || '',
            seconds: result.duration || 0,
          })
          return
        }

        if (op === 'finish') {
          const id = url.searchParams.get('id') || ''
          const entry = sessions.get(id)
          if (!entry) { sendJson(res, 404, { ok: false, error: 'unknown session' }); return }
          const eng = await ensureEngine()
          const result = await eng.finish(entry.session)
          sessions.delete(id)
          sendJson(res, 200, { ok: true, ...result, text: result.text || joinSegments(result.segments.map(s => s.text)) })
          return
        }

        if (op === 'debug/dump') {
          // Store the raw microphone PCM the client captured, so a "nothing was
          // recognised" report can be checked against the actual audio.
          const sr = Number(url.searchParams.get('sr')) || 16000
          const name = (url.searchParams.get('name') || 'dump').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)
          const body = await readBody(req, 64 * 1024 * 1024)
          const dir = await resolveModelsDir()
          const fsp = await import('node:fs/promises')
          const outDir = path.join(dir, 'debug')
          await fsp.mkdir(outDir, { recursive: true })
          const data = Buffer.from(body)
          const header = Buffer.alloc(44)
          header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
          header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
          header.writeUInt16LE(1, 22); header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28)
          header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
          header.write('data', 36); header.writeUInt32LE(data.length, 40)
          const file = path.join(outDir, `${Date.now()}-${name}.wav`)
          await fsp.writeFile(file, Buffer.concat([header, data]))
          sendJson(res, 200, { ok: true, file, bytes: data.length, sr })
          return
        }

        if (op === 'cancel') {
          const id = url.searchParams.get('id') || ''
          sessions.delete(id)
          sendJson(res, 200, { ok: true })
          return
        }

        sendJson(res, 404, { ok: false, error: `unknown route ${op}` })
      } catch (err) {
        const code = err?.code === 'models-missing' ? 409 : 500
        sendJson(res, code, { ok: false, error: String((err && err.message) || err), missing: err?.missing || null })
      }
    }

    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: route })
    ctx.effect(() => () => { try { dispose() } catch {} })

    // Warm the engine in the background once models are on disk, so the first
    // microphone press is not a 3 s stall.
    ;(async () => {
      try {
        await sleep(2500)
        if (await findReadyRoot({ ...config, packageRoot: PACKAGE_ROOT })) await ensureEngine()
      } catch (err) {
        warn(`warmup skipped: ${err && err.message}`)
      }
    })()
  })
}
