// Subtítulos automáticos con Whisper (whisper.cpp), todo local. El motor y el modelo
// se descargan la primera vez (no van en el instalador para que pese poco).

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { US } from '@shared/project'
import { type SubtitleJob, type TimedText, toTimeline } from '@shared/subtitles'
import { FFMPEG, run } from './media'

const MODEL = 'ggml-large-v3-turbo-q5_0.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`
// CUDA 12.4 trae cuBLAS dentro; funciona con drivers NVIDIA 525 o más nuevos (Pascal en adelante).
const ENGINE_GPU = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip'
const ENGINE_CPU = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'

export interface SubtitleProgress {
  stage: 'download-engine' | 'download-model' | 'transcribe'
  fraction: number
  label: string
}

const LONG_WORD_MS = 1200
const TYPICAL_WORD_MS = 450

// Compartido entre perfiles: el motor y el modelo pesan más de 1 GB.
const root = () => join(app.getPath('appData'), 'Cancun', 'whisper')
const exe = () => join(root(), 'bin', 'whisper-cli.exe')
const model = () => join(root(), MODEL)

async function download(url: string, dest: string, onFraction: (f: number) => void) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${url} (${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total) onFraction(got / total)
  })
  const tmp = `${dest}.part`
  await pipeline(body, createWriteStream(tmp))
  await rename(tmp, dest)
}

async function hasNvidia(): Promise<boolean> {
  try {
    await run('nvidia-smi', ['-L'])
    return true
  } catch {
    return false
  }
}

/** Deja listo el motor y el modelo (descarga lo que falte). */
export async function ensureWhisper(onProgress: (p: SubtitleProgress) => void): Promise<void> {
  await mkdir(root(), { recursive: true })
  if (!existsSync(exe())) {
    const gpu = await hasNvidia()
    const zip = join(root(), 'engine.zip')
    await download(gpu ? ENGINE_GPU : ENGINE_CPU, zip, (f) =>
      onProgress({ stage: 'download-engine', fraction: f, label: `Descargando el motor de transcripción${gpu ? ' (GPU)' : ''}…` })
    )
    const tmp = join(root(), 'unzip')
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    // tar de Windows 10 abre .zip.
    await run('tar', ['-xf', zip, '-C', tmp])
    await rm(join(root(), 'bin'), { recursive: true, force: true })
    // Los zips traen los ejecutables dentro de Release/ (o sueltos, según la versión).
    const inner = existsSync(join(tmp, 'Release', 'whisper-cli.exe')) ? join(tmp, 'Release') : tmp
    await rename(inner, join(root(), 'bin'))
    await rm(tmp, { recursive: true, force: true })
    await rm(zip, { force: true })
  }
  if (!existsSync(model())) {
    await download(MODEL_URL, model(), (f) => onProgress({ stage: 'download-model', fraction: f, label: 'Descargando el modelo de voz (una sola vez)…' }))
  }
}

/**
 * Transcribe los tramos y devuelve los subtítulos en tiempo de la línea de tiempo.
 * Todos los tramos van en un solo WAV para cargar el modelo una sola vez.
 */
export async function transcribeJobs(jobs: SubtitleJob[], lang: string, onProgress: (p: SubtitleProgress) => void): Promise<TimedText[]> {
  if (!jobs.length) return []
  await ensureWhisper(onProgress)
  onProgress({ stage: 'transcribe', fraction: 0, label: 'Preparando el audio…' })
  const dir = join(app.getPath('temp'), 'cancun-subs')
  await mkdir(dir, { recursive: true })
  const base = join(dir, `audio-${Date.now()}`)
  const wav = `${base}.wav`
  const inputs = jobs.flatMap((j) => ['-ss', (j.sourceIn / US).toFixed(3), '-t', (j.sourceDur / US).toFixed(3), '-i', j.path])
  // apad + atrim: cada tramo dura exactamente lo del clip aunque su audio sea más corto,
  // así los tiempos de Whisper caen en el tramo correcto.
  const graph = jobs.map((j, i) => `[${i}:a:0]aresample=16000,aformat=channel_layouts=mono,apad,atrim=0:${(j.sourceDur / US).toFixed(3)}[a${i}]`).join(';') +
    ';' + jobs.map((_, i) => `[a${i}]`).join('') + `concat=n=${jobs.length}:v=0:a=1[out]`
  await run(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-ar', '16000', '-ac', '1', wav])

  await new Promise<void>((resolve, reject) => {
    const args = ['-m', model(), '-f', wav, '-l', lang, '-ml', '42', '-sow', '-ojf', '-of', base, '-pp']
    const child = spawn(exe(), args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      err = (err + text).slice(-2000)
      const m = /progress =\s*(\d+)%/.exec(text)
      if (m) onProgress({ stage: 'transcribe', fraction: Number(m[1]) / 100, label: 'Transcribiendo…' })
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Whisper falló (${code}): ${err}`))))
  })
  type Span = { from: number; to: number }
  const json = JSON.parse(await readFile(`${base}.json`, 'utf8')) as { transcription: { offsets: Span; text: string; tokens?: { text: string; offsets: Span }[] }[] }
  await rm(wav, { force: true })
  await rm(`${base}.json`, { force: true })

  // Cada segmento va al tramo donde cae su mitad (los tramos están uno tras otro en el WAV).
  const offsets: number[] = []
  let acc = 0
  for (const j of jobs) {
    offsets.push(acc)
    acc += j.sourceDur
  }
  const out: TimedText[] = []
  for (const s of json.transcription) {
    const text = s.text.trim()
    if (!text || /^[[(].*[\])]$/.test(text)) continue
    // Tras un silencio, Whisper estira la primera palabra hasta el inicio del silencio;
    // si una palabra de los extremos dura demasiado, se recorta a una duración normal.
    const words = (s.tokens ?? []).filter((t) => !t.text.startsWith('[_') && t.text.trim())
    let from = s.offsets.from
    let to = s.offsets.to
    if (words.length) {
      const first = words[0].offsets
      const last = words[words.length - 1].offsets
      if (first.to - first.from > LONG_WORD_MS) from = Math.max(from, first.to - TYPICAL_WORD_MS)
      if (last.to - last.from > LONG_WORD_MS) to = Math.min(to, last.from + TYPICAL_WORD_MS)
    }
    from *= 1000
    to *= 1000
    const mid = (from + to) / 2
    let i = offsets.length - 1
    while (i > 0 && offsets[i] > mid) i--
    const local = { start: Math.max(0, from - offsets[i]), end: Math.min(jobs[i].sourceDur, to - offsets[i]), text }
    out.push(...toTimeline(jobs[i], [local]))
  }
  return out
}
