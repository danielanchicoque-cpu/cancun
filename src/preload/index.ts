import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { connect, type Socket } from 'node:net'

// Conexiones directas del motor de render a ffmpeg (sin pasar por el proceso principal).
const sinks = new Map<number, Socket>()
let nextSink = 1

function openSink(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let tries = 0
    const attempt = () => {
      const sock = connect({ host: '127.0.0.1', port })
      sock.setNoDelay(true)
      sock.once('connect', () => {
        const id = nextSink++
        sinks.set(id, sock)
        resolve(id)
      })
      sock.once('error', (err) => {
        sock.destroy()
        // ffmpeg puede tardar un momento en empezar a escuchar.
        if (++tries < 100) setTimeout(attempt, 100)
        else reject(err)
      })
    }
    attempt()
  })
}

function writeSink(id: number, data: Uint8Array): Promise<void> {
  const sock = sinks.get(id)
  if (!sock || sock.destroyed) return Promise.reject(new Error('ffmpeg cerró la conexión'))
  return new Promise((resolve, reject) => {
    const ok = sock.write(data, (err) => err && reject(err))
    if (ok) resolve()
    else sock.once('drain', () => resolve())
  })
}

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const h = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api = {
  projects: {
    list: () => invoke('projects:list'),
    load: (id: string) => invoke('projects:load', id),
    save: (p: unknown) => invoke('projects:save', p),
    remove: (id: string) => invoke('projects:delete', id)
  },
  media: {
    pick: () => invoke('media:pick'),
    probe: (paths: string[]) => invoke('media:probe', paths),
    filmstrip: (m: unknown) => invoke('media:filmstrip', m),
    waveform: (m: unknown) => invoke('media:waveform', m),
    reverse: (path: string) => invoke('media:reverse', path),
    pathOf: (file: File) => webUtils.getPathForFile(file)
  },
  sounds: {
    list: () => invoke('sounds:list')
  },
  luts: {
    list: () => invoke('luts:list'),
    sync: () => invoke('luts:sync'),
    import: () => invoke('luts:import'),
    load: (path: string) => invoke('luts:load', path)
  },
  exporter: {
    pick: (name: string, format: string) => invoke('export:pick', name, format),
    start: (p: unknown, output: string) => invoke('export:start', p, output),
    cancel: () => invoke('export:cancel'),
    onProgress: (cb: (p: { fraction: number; fps: number; eta: number }) => void) => listen('export:progress', cb)
  },
  subtitles: {
    run: (jobs: unknown, lang: string) => invoke('subtitles:run', jobs, lang),
    onProgress: (cb: (p: { stage: string; fraction: number; label: string }) => void) => listen('subtitles:progress', cb)
  },
  chat: {
    send: (text: string, context: unknown) => invoke('chat:send', text, context),
    stop: () => invoke('chat:stop'),
    reset: () => invoke('chat:reset'),
    onEvent: (cb: (e: { type: string; text?: string; tool?: string; error?: string }) => void) => listen('chat:event', cb)
  },
  paths: {
    app: () => invoke('paths:app')
  },
  decode: {
    open: (path: string, startUs: number, rate: number, w: number, h: number) => invoke('decode:open', path, startUs, rate, w, h),
    frame: (id: number) => invoke('decode:frame', id),
    close: (id: number) => invoke('decode:close', id)
  },
  render: {
    onJob: (cb: (job: never) => void) => listen('render:job', cb),
    onCancel: (cb: (jobId: number) => void) => listen('render:cancel', cb),
    frame: (jobId: number, data: Uint8Array, index: number) => invoke('render:frame', jobId, data, index),
    done: (jobId: number) => ipcRenderer.send('render:done', jobId),
    fail: (jobId: number, error: string) => ipcRenderer.send('render:fail', jobId, error),
    ready: () => ipcRenderer.send('render:ready'),
    progress: (jobId: number, index: number) => ipcRenderer.send('render:progress', jobId, index),
    sinkOpen: (port: number) => openSink(port),
    sinkWrite: (id: number, data: Uint8Array) => writeSink(id, data),
    sinkClose: (id: number) => {
      sinks.get(id)?.end()
      sinks.delete(id)
    }
  },
  reveal: (path: string) => invoke('shell:reveal', path),
  bridge: {
    onRequest: (cb: (req: { id: number; method: string; params: Record<string, unknown> }) => void) => listen('bridge:request', cb),
    reply: (msg: { id: number; result?: unknown; error?: string }) => ipcRenderer.send('bridge:reply', msg)
  }
}

contextBridge.exposeInMainWorld('cancun', api)

export type CancunApi = typeof api
