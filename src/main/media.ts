// Lectura de medios con ffprobe/ffmpeg: metadatos, tira de miniaturas y forma de onda.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { type Media, type MediaKind, US, newId } from '@shared/project'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma'])

// FFmpeg propio de Cancun (7.0.x): es el último que habla con el driver NVIDIA de la
// GTX 1060 para exportar por GPU. Si no está, se usa el del sistema.
const vendored = (name: string) => {
  const p = join(app.getAppPath(), 'vendor', 'ffmpeg', `${name}.exe`)
  return existsSync(p) ? p : name
}
export const FFMPEG = process.env.CANCUN_FFMPEG ?? vendored('ffmpeg')
export const FFPROBE = process.env.CANCUN_FFPROBE ?? vendored('ffprobe')

export function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} salió con ${code}: ${err}`))))
  })
}

const cacheDir = () => join(app.getPath('userData'), 'cache')

function cacheKey(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

interface ProbeStream {
  codec_type: string
  width?: number
  height?: number
  r_frame_rate?: string
  duration?: string
  color_space?: string
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
}

export async function probe(path: string): Promise<Media> {
  const ext = extname(path).toLowerCase()
  const raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  const info = JSON.parse(raw.toString()) as { format: { duration?: string }; streams: ProbeStream[] }
  const v = info.streams.find((s) => s.codec_type === 'video')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  const kind: MediaKind = IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) || !v ? 'audio' : 'video'
  const seconds = Number(info.format.duration ?? v?.duration ?? a?.duration ?? 0)
  let width = v?.width
  let height = v?.height
  const rotation = Math.abs(Number(v?.tags?.rotate ?? v?.side_data_list?.[0]?.rotation ?? 0))
  if (rotation === 90 || rotation === 270) [width, height] = [height, width]
  const [num, den] = (v?.r_frame_rate ?? '30/1').split('/').map(Number)
  return {
    id: newId(),
    kind,
    path,
    name: basename(path),
    duration: kind === 'image' ? 0 : Math.round(seconds * US),
    width: kind === 'audio' ? undefined : width,
    height: kind === 'audio' ? undefined : height,
    fps: kind === 'video' && den ? num / den : undefined,
    hasAudio: Boolean(a),
    colorSpace: v?.color_space && v.color_space !== 'unknown' ? v.color_space : undefined
  }
}

const FILMSTRIP_HEIGHT = 72

export interface Filmstrip {
  path: string
  /** Cuadros en la tira (uno por intervalo igual de la duración). */
  frames: number
}

/**
 * Una imagen con N cuadros en fila (aprox. uno por segundo), para dibujar el clip en
 * la línea de tiempo con cada cuadro en su proporción real.
 */
export async function filmstrip(media: Media): Promise<Filmstrip> {
  await mkdir(cacheDir(), { recursive: true })
  const seconds = Math.max(media.duration / US, 0.1)
  const frames = media.kind === 'image' ? 1 : Math.max(8, Math.min(200, Math.ceil(seconds)))
  const out = join(cacheDir(), `${cacheKey(media.path)}-strip${frames}.jpg`)
  if (existsSync(out)) return { path: out, frames }
  if (media.kind === 'image') {
    await run(FFMPEG, ['-y', '-v', 'error', '-i', media.path, '-vf', `scale=-2:${FILMSTRIP_HEIGHT}`, out])
    return { path: out, frames }
  }
  const vf = `fps=${(frames / seconds).toFixed(6)},scale=-2:${FILMSTRIP_HEIGHT},tile=${frames}x1`
  await run(FFMPEG, ['-y', '-v', 'error', '-hwaccel', 'auto', '-i', media.path, '-an', '-vf', vf, '-frames:v', '1', '-q:v', '5', out]).catch(() =>
    run(FFMPEG, ['-y', '-v', 'error', '-i', media.path, '-an', '-vf', vf, '-frames:v', '1', '-q:v', '5', out])
  )
  return { path: out, frames }
}

const PEAKS_PER_SECOND = 100
const PEAK_SAMPLE_RATE = 8000

/** Picos de audio normalizados 0..1, 100 por segundo. */
export async function waveform(media: Media): Promise<number[]> {
  await mkdir(cacheDir(), { recursive: true })
  const out = join(cacheDir(), `${cacheKey(media.path)}-peaks.json`)
  if (existsSync(out)) return JSON.parse(await readFile(out, 'utf8')) as number[]
  const pcm = await run(FFMPEG, ['-v', 'error', '-i', media.path, '-vn', '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE), '-f', 's16le', '-'])
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  const per = PEAK_SAMPLE_RATE / PEAKS_PER_SECOND
  const peaks: number[] = []
  for (let i = 0; i < samples.length; i += per) {
    let max = 0
    for (let j = i; j < Math.min(i + per, samples.length); j++) max = Math.max(max, Math.abs(samples[j]))
    peaks.push(Math.round((max / 32768) * 1000) / 1000)
  }
  await writeFile(out, JSON.stringify(peaks))
  return peaks
}

/** Versión invertida del video (para "Invertir"); se guarda en caché junto a las miniaturas. */
export async function reverseMedia(path: string): Promise<string> {
  await mkdir(cacheDir(), { recursive: true })
  const out = join(cacheDir(), `${cacheKey(path)}-reverse.mp4`)
  if (existsSync(out)) return out
  const info = await probe(path)
  const args = ['-y', '-v', 'error', '-i', path, '-vf', 'reverse', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p']
  if (info.hasAudio) args.push('-af', 'areverse', '-c:a', 'aac', '-b:a', '256k')
  args.push(out)
  await run(FFMPEG, args)
  return out
}

export interface SoundEntry {
  name: string
  path: string
  /** Carpeta dentro de la biblioteca (vacía = raíz). */
  category: string
}

const AUDIO_FILE = /\.(mp3|wav|aac|m4a|flac|ogg|opus|wma)$/i

/** Efectos de sonido de Daniel: todos los audios de la carpeta, con su subcarpeta como categoría. */
export async function listSounds(root: string): Promise<SoundEntry[]> {
  const { readdir } = await import('node:fs/promises')
  const out: SoundEntry[] = []
  async function walk(dir: string, category: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full, category ? `${category} / ${e.name}` : e.name)
      else if (AUDIO_FILE.test(e.name)) out.push({ name: e.name.replace(/\.[^.]+$/, ''), path: full, category })
    }
  }
  await walk(root, '')
  return out.sort((a, b) => a.category.localeCompare(b.category, 'es') || a.name.localeCompare(b.name, 'es'))
}
