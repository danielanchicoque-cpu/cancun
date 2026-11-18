// DeepFilterNet (https://github.com/Rikorose/DeepFilterNet, MIT/Apache-2.0): red neuronal
// de reducción de ruido para voz a 48 kHz. Medido contra CapCut queda mucho más cerca que
// el motor espectral (aislar voz: 9,2 dB de SI-SDR frente a 3,8). El ejecutable se descarga
// la primera vez (27 MB) y se comparte entre perfiles, como Whisper. Si no se puede bajar o
// falla, Cancun sigue con su motor espectral.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const VERSION = '0.5.6'
const URL = `https://github.com/Rikorose/DeepFilterNet/releases/download/v${VERSION}/deep-filter-${VERSION}-x86_64-pc-windows-msvc.exe`
const root = () => join(app.getPath('appData'), 'Cancun', 'deepfilter')
const exe = () => join(root(), `deep-filter-${VERSION}.exe`)

let installing: Promise<string | null> | null = null
/** Si la descarga falló en esta sesión no se reintenta en cada clip. */
let unavailable = false

/** Ruta del ejecutable (lo descarga si falta) o null si no está disponible. */
export function ensureDeepFilter(onProgress?: (f: number) => void): Promise<string | null> {
  if (process.platform !== 'win32' || unavailable) return Promise.resolve(null)
  if (existsSync(exe())) return Promise.resolve(exe())
  installing ??= (async () => {
    try {
      await mkdir(root(), { recursive: true })
      const res = await fetch(URL, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`descarga ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      let got = 0
      const body = Readable.fromWeb(res.body as never)
      body.on('data', (c: Buffer) => {
        got += c.length
        if (total) onProgress?.(got / total)
      })
      const tmp = `${exe()}.part`
      await pipeline(body, createWriteStream(tmp))
      await rename(tmp, exe())
      return exe()
    } catch (err) {
      console.warn('DeepFilterNet no disponible:', err)
      unavailable = true
      return null
    } finally {
      installing = null
    }
  })()
  return installing
}

/** WAV PCM de 16 bits mono (lo que lee deep-filter). */
function wav16(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/**
 * Limpia audio mono de 48 kHz con DeepFilterNet. `atten` = límite de atenuación en dB
 * (100 = sin límite). Devuelve la ruta del WAV resultante (el llamador lo decodifica) y
 * una función para borrar los temporales.
 */
export async function runDeepFilter(bin: string, samples: Float32Array, rate: number, atten: number): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(app.getPath('temp'), 'cancun-df-'))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    const input = join(dir, 'voz.wav')
    await writeFile(input, wav16(samples, rate))
    const out = join(dir, 'out')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['-D', '-a', String(atten), '-o', out, input], { windowsHide: true, cwd: dir })
      let err = ''
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`deep-filter salió con ${code}: ${err}`))))
    })
    const files = existsSync(out) ? await readdir(out) : []
    if (!files.length) throw new Error('deep-filter no escribió el resultado')
    return { path: join(out, files[0]), cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
