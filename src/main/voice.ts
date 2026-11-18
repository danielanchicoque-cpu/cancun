// Procesa la voz de un clip (reducir ruido, aislar, mejorar) y deja el resultado en
// caché como WAV. Todo en local: ffmpeg decodifica, el motor espectral de Cancun
// (src/shared/voiceDsp.ts) limpia en un hilo aparte y ffmpeg aplica la cadena final.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { US } from '@shared/project'
import { type VoiceJob, type VoiceResult, neuralPlan, voiceKey, voiceOptions, voicePostFilter } from '@shared/voice'
import { ensureDeepFilter, runDeepFilter } from './deepFilter'
import { FFMPEG, FFPROBE, run } from './media'
import workerPath from './voiceWorker?modulePath'

const RATE = 48000
const cacheDir = () => join(app.getPath('userData'), 'voice')
const inflight = new Map<string, Promise<VoiceResult>>()

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (s: Float32Array) => void; reject: (e: Error) => void; progress?: (f: number) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(workerPath)
  w.on('message', (m: { id: number; samples?: Float32Array; progress?: number; error?: string }) => {
    const job = pending.get(m.id)
    if (!job) return
    if (m.progress !== undefined) return job.progress?.(m.progress)
    pending.delete(m.id)
    if (m.error) job.reject(new Error(m.error))
    else job.resolve(m.samples!)
  })
  w.on('error', (err) => {
    for (const j of pending.values()) j.reject(err)
    pending.clear()
    worker = null
  })
  w.on('exit', () => (worker = null))
  worker = w
  return w
}

function clean(samples: Float32Array, opts: NonNullable<ReturnType<typeof voiceOptions>>, progress?: (f: number) => void): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, progress })
    getWorker().postMessage({ id, samples, sampleRate: RATE, opts }, [samples.buffer as ArrayBuffer])
  })
}

/** Canales del primer flujo de audio (para promediarlos sin el +3 dB del "-ac 1" de ffmpeg). */
async function channels(path: string): Promise<number> {
  const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', path])
  return Math.max(1, Number(out.toString().trim()) || 1)
}

/** Decodifica (un tramo de) un archivo a mono 48 kHz en punto flotante. */
async function decode(path: string, range?: { start: number; duration: number }): Promise<Float32Array> {
  const ch = await channels(path)
  const cut = range ? ['-ss', (range.start / US).toFixed(3), '-t', (range.duration / US).toFixed(3)] : []
  const raw = await run(FFMPEG, ['-v', 'error', ...cut, '-i', path, '-vn', '-map', '0:a:0', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'])
  const all = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
  const mono = new Float32Array(Math.floor(all.length / ch))
  for (let i = 0; i < mono.length; i++) {
    let s = 0
    for (let c = 0; c < ch; c++) s += all[i * ch + c]
    mono[i] = s / ch
  }
  return mono
}

/** Escribe el audio limpio pasando por la cadena final de ffmpeg. */
function encode(samples: Float32Array, filter: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-af', filter, '-c:a', 'pcm_s16le', dest], {
      windowsHide: true
    })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-3000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (voz) salió con ${code}: ${err}`))))
    child.stdin.on('error', () => undefined)
    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
  })
}

/** Devuelve el WAV procesado del trabajo (lo calcula la primera vez y lo deja en caché). */
export function prepareVoice(job: VoiceJob, onProgress?: (f: number) => void): Promise<VoiceResult> {
  const key = voiceKey(job)
  const running = inflight.get(key)
  if (running) return running
  const task = (async () => {
    const dir = cacheDir()
    await mkdir(dir, { recursive: true })
    const file = (engine: string) => join(dir, `${createHash('sha1').update(key + engine).digest('hex').slice(0, 20)}.wav`)
    // Motor neuronal si se puede (se descarga la primera vez); si no, el espectral.
    const plan = neuralPlan(job)
    const bin = plan ? await ensureDeepFilter((f) => onProgress?.(f * 0.1)) : null
    for (const engine of bin ? ['df', 'dsp'] : ['dsp']) if (existsSync(file(engine))) return { path: file(engine), start: job.start, duration: job.duration }
    let samples = await decode(job.path, job)
    onProgress?.(0.15)
    let engine = 'dsp'
    if (bin && plan) {
      try {
        const out = await runDeepFilter(bin, samples, RATE, plan.atten)
        try {
          samples = await decode(out.path)
        } finally {
          await out.cleanup()
        }
        onProgress?.(0.6)
        if (plan.shape) samples = await clean(samples, plan.shape, (f) => onProgress?.(0.6 + f * 0.3))
        engine = 'df'
      } catch (err) {
        console.warn('DeepFilterNet falló; se usa el motor espectral', err)
      }
    }
    if (engine === 'dsp') {
      const opts = voiceOptions(job)
      if (opts) samples = await clean(samples, opts, (f) => onProgress?.(0.15 + f * 0.75))
    }
    const dest = file(engine)
    const result = { path: dest, start: job.start, duration: job.duration }
    const tmp = `${dest}.part.wav`
    await encode(samples, voicePostFilter(job), tmp)
    await rm(dest, { force: true })
    await rename(tmp, dest)
    onProgress?.(1)
    return result
  })()
  inflight.set(key, task)
  task.finally(() => inflight.delete(key)).catch(() => undefined)
  return task
}
