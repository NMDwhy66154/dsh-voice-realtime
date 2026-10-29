// Model inventory + resumable downloader for dsh-voice-realtime.
// Models are downloaded from hf-mirror (huggingface.co is unreachable on many
// networks) into $DSH_HOME/voice-models, or read from <package>/models when the
// package ships them.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MIRROR = 'https://hf-mirror.com'
const SV_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const SV_REV = '2365baeacb507f821a0c8120fcee3d484dba7a07'
const STREAM_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20'

/** Files needed for the hybrid engine. `size` doubles as the integrity check. */
export const MODEL_FILES = [
  { role: 'streaming-encoder', optional: true, rel: 'streaming/encoder-epoch-99-avg-1.int8.onnx', size: 181895032, url: `${MIRROR}/${STREAM_REPO}/resolve/main/encoder-epoch-99-avg-1.int8.onnx` },
  { role: 'streaming-decoder', optional: true, rel: 'streaming/decoder-epoch-99-avg-1.int8.onnx', size: 13091040, url: `${MIRROR}/${STREAM_REPO}/resolve/main/decoder-epoch-99-avg-1.int8.onnx` },
  { role: 'streaming-joiner', optional: true, rel: 'streaming/joiner-epoch-99-avg-1.int8.onnx', size: 3228404, url: `${MIRROR}/${STREAM_REPO}/resolve/main/joiner-epoch-99-avg-1.int8.onnx` },
  { role: 'streaming-tokens', optional: true, rel: 'streaming/tokens.txt', size: 56317, url: `${MIRROR}/${STREAM_REPO}/resolve/main/tokens.txt` },
  { role: 'sensevoice-model', rel: 'sensevoice/model.int8.onnx', size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', url: `${MIRROR}/${SV_REPO}/resolve/${SV_REV}/model.int8.onnx` },
  { role: 'sensevoice-tokens', rel: 'sensevoice/tokens.txt', size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', url: `${MIRROR}/${SV_REPO}/resolve/${SV_REV}/tokens.txt` },
]

export const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** Candidate model roots, most specific first. */
export function modelRoots(config) {
  const out = []
  if (config?.modelsDir) out.push(path.resolve(config.modelsDir))
  if (process.env.DSH_VOICE_MODELS_DIR) out.push(path.resolve(process.env.DSH_VOICE_MODELS_DIR))
  if (config?.packageRoot) out.push(path.join(config.packageRoot, 'models'))
  out.push(path.join(dshHome(), 'voice-models'))
  return [...new Set(out)]
}

async function sizeOf(file) {
  try { return (await stat(file)).size } catch { return -1 }
}

/** Report which files exist in `dir`. */
export async function report(dir) {
  const present = []
  const missing = []
  for (const f of MODEL_FILES) {
    const p = path.join(dir, f.rel)
    const size = await sizeOf(p)
    if (size === f.size) present.push({ role: f.role, path: p, size })
    else missing.push({ role: f.role, rel: f.rel, size: f.size, expected: f.size, optional: !!f.optional, url: f.url })
  }
  const required = missing.filter(m => !m.optional)
  return { dir, ready: required.length === 0, present, missing }
}

/** First root that already holds a complete model set. */
export async function findReadyRoot(config) {
  for (const dir of modelRoots(config)) {
    const r = await report(dir)
    if (r.ready) return r
  }
  return null
}

/** Writable download target: first existing model root, else $DSH_HOME/voice-models. */
export async function downloadTarget(config, prefer) {
  if (prefer && !prefer.ready) return prefer.dir
  const dir = path.join(dshHome(), 'voice-models')
  await mkdir(dir, { recursive: true })
  return dir
}

const state = {
  active: false,
  dir: '',
  startedAt: 0,
  finishedAt: 0,
  error: '',
  current: '',
  fileIndex: 0,
  fileCount: MODEL_FILES.length,
  bytes: 0,
  totalBytes: MODEL_FILES.reduce((n, f) => n + f.size, 0),
  log: [],
}
const CHUNK = 4 * 1024 * 1024
const CONN = 5

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function note(line) {
  state.log.push(`${new Date().toISOString()} ${line}`)
  if (state.log.length > 60) state.log.shift()
  console.log(`[dsh-voice] ${line}`)
}

async function fetchChunk(url, start, end, label, cooldown) {
  let attempt = 0
  while (true) {
    attempt++
    if (cooldown.until > Date.now()) await sleep(cooldown.until - Date.now())
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'dsh-voice-realtime/0.1' },
        signal: AbortSignal.timeout(180000),
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`)
      if (res.status !== 206 && !(res.status === 200 && start === 0)) throw new Error(`status ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length !== end - start + 1) throw new Error(`short read ${buf.length}/${end - start + 1}`)
      return buf
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (attempt >= 12) throw new Error(`${label}: ${msg}`)
      if (/429|status 5/.test(msg)) cooldown.until = Date.now() + Math.min(30000, 1500 * attempt)
      else await sleep(Math.min(20000, 800 * attempt))
    }
  }
}

async function concat(parts, dst) {
  await rm(dst, { force: true })
  const ws = createWriteStream(dst)
  for (const p of parts) {
    await new Promise((resolve, reject) => {
      const rs = createReadStream(p)
      rs.on('error', reject)
      rs.on('end', resolve)
      rs.pipe(ws, { end: false })
    })
  }
  await new Promise((resolve, reject) => { ws.on('error', reject); ws.end(resolve) })
}

async function hashes(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const rs = createReadStream(file)
    rs.on('data', d => hash.update(d))
    rs.on('error', reject)
    rs.on('end', resolve)
  })
  return hash.digest('hex')
}

async function fetchFile(file, dir, cooldown) {
  const dst = path.join(dir, file.rel)
  await mkdir(path.dirname(dst), { recursive: true })
  if ((await sizeOf(dst)) === file.size) return
  state.current = file.rel

  const jobs = []
  for (let s = 0; s < file.size; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, file.size - 1)
    jobs.push({ idx: jobs.length, start: s, end: e, part: `${dst}.c${jobs.length}.part` })
  }
  let cursor = 0
  const worker = async () => {
    while (true) {
      const i = cursor++
      if (i >= jobs.length) return
      const j = jobs[i]
      if ((await sizeOf(j.part)) === j.end - j.start + 1) continue
      const buf = await fetchChunk(file.url, j.start, j.end, `${file.rel}#${j.idx}`, cooldown)
      await writeFile(j.part, buf)
      state.bytes += buf.length
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONN, jobs.length) }, worker))

  for (const j of jobs) {
    if ((await sizeOf(j.part)) !== j.end - j.start + 1) throw new Error(`chunk ${j.idx} incomplete for ${file.rel}`)
  }
  await concat(jobs.map(j => j.part), dst)
  if ((await sizeOf(dst)) !== file.size) throw new Error(`size mismatch for ${file.rel}`)
  if (file.sha256) {
    const got = await hashes(dst)
    if (got !== file.sha256) { await rm(dst, { force: true }); throw new Error(`sha256 mismatch for ${file.rel}`) }
  }
  for (const j of jobs) await rm(j.part, { force: true })
  note(`downloaded ${file.rel} (${(file.size / 1048576).toFixed(1)} MB)`)
}

export function downloadStatus() {
  return { ...state, log: state.log.slice(-12) }
}

/** Kick off (idempotent) background download of every missing file into `dir`. */
export function startDownload(dir) {
  if (state.active) return downloadStatus()
  state.active = true
  state.dir = dir
  state.startedAt = Date.now()
  state.finishedAt = 0
  state.error = ''
  state.bytes = 0
  note(`downloading into ${dir}`)
  const cooldown = { until: 0 }
  ;(async () => {
    try {
      for (let i = 0; i < MODEL_FILES.length; i++) {
        state.fileIndex = i
        state.current = MODEL_FILES[i].rel
        await fetchFile(MODEL_FILES[i], dir, cooldown)
      }
      state.current = ''
      note('all model files present')
    } catch (err) {
      state.error = String((err && err.message) || err)
      note(`download failed: ${state.error}`)
    } finally {
      state.active = false
      state.finishedAt = Date.now()
    }
  })()
  return downloadStatus()
}
