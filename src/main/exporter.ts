// Ejecuta la exportación: detecta el codificador que sirve en este equipo,
// prepara los archivos temporales y reporta el progreso.

import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CubeLut } from '@shared/cube'
import { buildExport } from '@shared/exportGraph'
import type { Project } from '@shared/project'
import { loadLut } from './luts'
import { FFMPEG, run } from './media'

const FONT_DIR = join(process.env.WINDIR ?? 'C:/Windows', 'Fonts')

const encoderCache = new Map<string, string>()

/** Prueba de verdad (codifica un cuadro), porque ffmpeg lista encoders que el driver no soporta. */
export async function pickEncoder(codec: 'h264' | 'hevc', hardware: boolean): Promise<string> {
  const key = `${codec}:${hardware}`
  const cached = encoderCache.get(key)
  if (cached) return cached
  const software = codec === 'hevc' ? 'libx265' : 'libx264'
  const candidates = hardware ? [`${codec}_nvenc`, `${codec}_qsv`, `${codec}_amf`, software] : [software]
  for (const enc of candidates) {
    try {
      await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'])
      encoderCache.set(key, enc)
      return enc
    } catch {
      continue
    }
  }
  throw new Error('No hay ningún codificador de video disponible en ffmpeg')
}

export interface ExportProgress {
  fraction: number
  speed: string
}

export interface ExportJob {
  done: Promise<void>
  cancel(): void
  encoder: string
}

export async function startExport(
  project: Project,
  output: string,
  onProgress: (p: ExportProgress) => void
): Promise<ExportJob> {
  const luts = new Map<string, CubeLut>()
  for (const t of project.tracks)
    for (const c of t.clips) if (c.type === 'media' && c.color.lut) luts.set(c.color.lut.path, await loadLut(c.color.lut.path))

  const encoder = await pickEncoder(project.export.codec, project.export.hardware)
  const tmpDir = await mkdtemp(join(app.getPath('temp'), 'cancun-export-'))
  const plan = buildExport(project, { output, tmpDir, luts, fontDir: FONT_DIR, encoder })
  for (const f of plan.files) await writeFile(f.path, f.content, 'utf8')

  let child: ChildProcess | null = null
  let cancelled = false
  const done = new Promise<void>((resolve, reject) => {
    child = spawn(FFMPEG, plan.args, { windowsHide: true })
    let err = ''
    let buf = ''
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      let speed = ''
      for (const line of lines) {
        const [k, v] = line.trim().split('=')
        if (k === 'speed') speed = v
        if (k === 'out_time_us') onProgress({ fraction: Math.min(1, Number(v) / plan.duration), speed })
      }
    })
    child.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-6000)))
    child.on('error', reject)
    child.on('close', (code) => {
      rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      if (cancelled) reject(new Error('Exportación cancelada'))
      else if (code === 0) {
        onProgress({ fraction: 1, speed: '' })
        resolve()
      } else reject(new Error(`ffmpeg falló (${code}):\n${err}`))
    })
  })
  return {
    done,
    encoder,
    cancel() {
      cancelled = true
      child?.kill()
    }
  }
}
