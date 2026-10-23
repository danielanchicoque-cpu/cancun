import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
    ready: () => ipcRenderer.send('render:ready')
  },
  reveal: (path: string) => invoke('shell:reveal', path),
  bridge: {
    onRequest: (cb: (req: { id: number; method: string; params: Record<string, unknown> }) => void) => listen('bridge:request', cb),
    reply: (msg: { id: number; result?: unknown; error?: string }) => ipcRenderer.send('bridge:reply', msg)
  }
}

contextBridge.exposeInMainWorld('cancun', api)

export type CancunApi = typeof api
