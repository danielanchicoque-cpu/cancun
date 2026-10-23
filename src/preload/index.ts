import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

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
    pathOf: (file: File) => webUtils.getPathForFile(file)
  },
  luts: {
    list: () => invoke('luts:list'),
    sync: () => invoke('luts:sync'),
    import: () => invoke('luts:import'),
    load: (path: string) => invoke('luts:load', path)
  },
  exporter: {
    pick: (name: string) => invoke('export:pick', name),
    start: (p: unknown, output: string) => invoke('export:start', p, output),
    cancel: () => invoke('export:cancel'),
    onProgress: (cb: (p: { fraction: number; speed: string }) => void) => {
      const h = (_e: unknown, p: { fraction: number; speed: string }) => cb(p)
      ipcRenderer.on('export:progress', h)
      return () => ipcRenderer.removeListener('export:progress', h)
    }
  },
  reveal: (path: string) => invoke('shell:reveal', path),
  bridge: {
    onRequest: (cb: (req: { id: number; method: string; params: Record<string, unknown> }) => void) => {
      ipcRenderer.on('bridge:request', (_e, req) => cb(req))
    },
    reply: (msg: { id: number; result?: unknown; error?: string }) => ipcRenderer.send('bridge:reply', msg)
  }
}

contextBridge.exposeInMainWorld('cancun', api)

export type CancunApi = typeof api
