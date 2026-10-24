// Exportación: la ventana oculta de render dibuja cada cuadro con el compositor GPU
// (el mismo de la vista previa) y aquí se le pasan a ffmpeg, que mezcla el audio y
// codifica con la tarjeta gráfica si está disponible.

import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'

/** Un puerto libre en 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
import { buildExport } from '@shared/exportGraph'
import type { Project } from '@shared/project'
import { FFMPEG, run } from './media'

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
  /** Cuadros por segundo de render. */
  fps: number
  /** Segundos restantes estimados. */
  eta: number
}

let renderWin: BrowserWindow | null = null
let renderReady: Promise<void> | null = null

function renderWindow(preload: string, rendererUrl: string | undefined, rendererDir: string): Promise<BrowserWindow> {
  if (renderWin && !renderWin.isDestroyed() && renderReady) return renderReady.then(() => renderWin!)
  renderWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false }
  })
  renderReady = new Promise<void>((resolve) => ipcMain.once('render:ready', () => resolve()))
  // Lo que imprime el motor de render queda en render.log (para diagnosticar exportaciones).
  const log = join(app.getPath('userData'), 'render.log')
  renderWin.webContents.on('console-message', (e) => {
    void appendFile(log, `[${new Date().toISOString()}] ${e.level} ${e.message}
`).catch(() => undefined)
  })
  if (rendererUrl) void renderWin.loadURL(`${rendererUrl}/render.html`)
  else void renderWin.loadFile(join(rendererDir, 'render.html'))
  renderWin.on('closed', () => {
    renderWin = null
    renderReady = null
  })
  return renderReady.then(() => renderWin!)
}

interface Job {
  ffmpeg: ChildProcess
  frames: number
  done: (err?: Error) => void
  onProgress: (p: ExportProgress) => void
  started: number
}

const jobs = new Map<number, Job>()
let nextJob = 1

export function registerRenderIpc() {
  ipcMain.handle('render:frame', async (_e, jobId: number, data: Uint8Array, index: number) => {
    const job = jobs.get(jobId)
    if (!job) throw new Error('Exportación cancelada')
    const stdin = job.ffmpeg.stdin!
    if (stdin.destroyed || stdin.writableEnded) return
    if (!stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) {
      // Si ffmpeg deja de leer (llegó a la duración o falló), no hay que quedarse esperando.
      await new Promise<void>((r) => {
        const done = () => {
          stdin.off('drain', done)
          stdin.off('close', done)
          stdin.off('error', done)
          r()
        }
        stdin.once('drain', done)
        stdin.once('close', done)
        stdin.once('error', done)
      })
    }
    if (index + 1 >= job.frames) stdin.end()
    const elapsed = (Date.now() - job.started) / 1000
    const fps = (index + 1) / Math.max(elapsed, 0.001)
    job.onProgress({ fraction: (index + 1) / job.frames, fps, eta: (job.frames - index - 1) / Math.max(fps, 0.001) })
  })
  ipcMain.on('render:progress', (_e, jobId: number, index: number) => {
    const job = jobs.get(jobId)
    if (!job) return
    const elapsed = (Date.now() - job.started) / 1000
    const fps = (index + 1) / Math.max(elapsed, 0.001)
    job.onProgress({ fraction: (index + 1) / job.frames, fps, eta: (job.frames - index - 1) / Math.max(fps, 0.001) })
  })
  ipcMain.on('render:done', (_e, jobId: number) => jobs.get(jobId)?.ffmpeg.stdin?.end())
  ipcMain.on('render:fail', (_e, jobId: number, error: string) => {
    const job = jobs.get(jobId)
    if (!job) return
    job.ffmpeg.kill()
    job.done(new Error(error))
  })
}

export interface ExportJob {
  done: Promise<void>
  cancel(): void
  encoder: string
}

export async function startExport(
  project: Project,
  output: string,
  onProgress: (p: ExportProgress) => void,
  window: { preload: string; rendererUrl: string | undefined; rendererDir: string }
): Promise<ExportJob> {
  const encoder = await pickEncoder(project.export.codec, project.export.hardware)
  const tmpDir = await mkdtemp(join(app.getPath('temp'), 'cancun-export-'))
  const filterPath = join(tmpDir, 'audio.txt').replace(/\\/g, '/')
  const sinkPort = await freePort()
  const plan = buildExport(project, { output, encoder, filterPath, input: `tcp://127.0.0.1:${sinkPort}?listen=1` })
  if (plan.filter) await writeFile(filterPath, plan.filter, 'utf8')

  const win = await renderWindow(window.preload, window.rendererUrl, window.rendererDir)
  const jobId = nextJob++
  const ffmpeg = spawn(FFMPEG, plan.args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  ffmpeg.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-6000)))
  let cancelled = false

  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      jobs.delete(jobId)
      rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      if (err) reject(err)
      else resolve()
    }
    jobs.set(jobId, { ffmpeg, frames: plan.frames, done: finish, onProgress, started: Date.now() })
    ffmpeg.on('error', (e) => finish(e))
    ffmpeg.stdin!.on('error', () => undefined)
    ffmpeg.on('close', (code) => {
      if (cancelled) finish(new Error('Exportación cancelada'))
      else if (code === 0) {
        onProgress({ fraction: 1, fps: 0, eta: 0 })
        finish()
      } else finish(new Error(`ffmpeg falló (${code}):\n${stderr}`))
    })
  })

  win.webContents.send('render:job', {
    jobId,
    project,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    frames: plan.frames,
    start: 0,
    sinkPort
  })

  return {
    done,
    encoder,
    cancel() {
      cancelled = true
      win.webContents.send('render:cancel', jobId)
      ffmpeg.kill()
    }
  }
}
