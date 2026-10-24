import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { type Project, normalizeProject } from '@shared/project'
import { startBridge } from './bridge'
import { resetChat, sendChat, stopChat, type ChatContext } from './chat'
import { closeDecode, nextFrame, openDecode } from './decodeFallback'
import { registerRenderIpc, startExport, type ExportJob } from './exporter'
import { importLuts, listLuts, loadLut, syncFromCapCut } from './luts'
import { filmstrip, listSounds, probe, reverseMedia, unpackedRoot, waveform } from './media'
import { deleteProject, listProjects, loadProject, saveProject } from './projectStore'

// Esquema propio para que el reproductor lea archivos locales con saltos (Range),
// sin abrir el acceso general a file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
])

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
}

function serveMedia(request: Request): Response {
  const path = decodeURIComponent(new URL(request.url).pathname.slice(1))
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return new Response('no existe', { status: 404 })
  }
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
  if (!range) {
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' }
    })
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
    status: 206,
    headers: {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes', 'access-control-allow-origin': '*'
    }
  })
}

const here = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(here, '../preload/index.cjs')
const rendererDir = join(here, '../renderer')

/** Efectos de sonido de Daniel (pack de creadores virales). */
const soundsRoot = () => join(app.getPath('desktop'), 'Multimedia y Contenido', 'Recursos', 'PACK RECURSOS CREADORES VIRALES', 'EFECTOS DE SONIDO')

let win: BrowserWindow | null = null
let exportJob: ExportJob | null = null

// --- Llamadas del puente hacia la ventana -------------------------------------------
let nextReq = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** Métodos que pueden tardar mucho (no se cortan por tiempo). */
const LONG_METHODS = new Set(['export'])

function callRenderer(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!win) return Promise.reject(new Error('Cancun no tiene ninguna ventana abierta'))
  const id = nextReq++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    win!.webContents.send('bridge:request', { id, method, params })
    if (!LONG_METHODS.has(method))
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`La ventana no respondió a "${method}"`))
      }, 120_000)
  })
}

ipcMain.on('bridge:reply', (_e, msg: { id: number; result?: unknown; error?: string }) => {
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
})

async function handleBridge(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'projects':
      return listProjects()
    case 'luts':
      return listLuts()
    case 'probe':
      return Promise.all((params.paths as string[]).map((p) => probe(p)))
    case 'screenshot': {
      if (!win) throw new Error('Cancun no tiene ninguna ventana abierta')
      const img = await win.webContents.capturePage()
      return { png: img.toDataURL() }
    }
    default:
      return callRenderer(method, params)
  }
}

// --- IPC de la interfaz ---------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:load', async (_e, id: string) => normalizeProject(await loadProject(id)))
  ipcMain.handle('projects:save', (_e, p: Project) => saveProject(p))
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))

  ipcMain.handle('media:pick', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Importar',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Multimedia', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'Todos', extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('media:probe', (_e, paths: string[]) => Promise.all(paths.map((p) => probe(p))))
  ipcMain.handle('media:filmstrip', (_e, m) => filmstrip(m))
  ipcMain.handle('media:waveform', (_e, m) => waveform(m))
  ipcMain.handle('media:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('media:reverse', (_e, path: string) => reverseMedia(path))
  ipcMain.handle('sounds:list', () => listSounds(soundsRoot()))
  ipcMain.handle('paths:app', () => unpackedRoot())
  ipcMain.handle('decode:open', (_e, path: string, startUs: number, rate: number, w: number, h: number) => openDecode(path, startUs, rate, w, h))
  ipcMain.handle('decode:frame', (_e, id: number) => nextFrame(id))
  ipcMain.handle('decode:close', (_e, id: number) => closeDecode(id))
  ipcMain.handle('chat:send', (_e, text: string, ctx: ChatContext) =>
    sendChat(text, ctx, app.getAppPath(), (ev) => win?.webContents.send('chat:event', ev))
  )
  ipcMain.handle('chat:stop', () => stopChat())
  ipcMain.handle('chat:reset', () => resetChat())
  registerRenderIpc()

  ipcMain.handle('luts:list', () => listLuts())
  ipcMain.handle('luts:sync', () => syncFromCapCut())
  ipcMain.handle('luts:import', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Importar LUT',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'LUT', extensions: ['cube'] }]
    })
    return r.canceled ? [] : importLuts(r.filePaths)
  })
  ipcMain.handle('luts:load', async (_e, path: string) => {
    const lut = await loadLut(path)
    return { size: lut.size, domainMin: lut.domainMin, domainMax: lut.domainMax, title: lut.title, data: lut.data }
  })

  ipcMain.handle('export:pick', async (_e, name: string, format: string = 'mp4') => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Exportar',
      defaultPath: join(app.getPath('videos'), `${name || 'Cancun'}.${format}`),
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    return r.canceled ? null : r.filePath
  })
  ipcMain.handle('export:start', async (_e, project: Project, output: string) => {
    if (exportJob) throw new Error('Ya hay una exportación en curso')
    const job = await startExport(project, output, (p) => win?.webContents.send('export:progress', p), {
      preload: preloadPath,
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererDir
    })
    exportJob = job
    try {
      await job.done
      return { output, encoder: job.encoder }
    } finally {
      exportJob = null
    }
  })
  ipcMain.handle('export:cancel', () => exportJob?.cancel())
  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#141414',
    title: 'Cancun',
    icon: join(here, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => {
    win!.maximize()
    win!.show()
  })
  win.on('closed', () => {
    win = null
    // Cierra también la ventana oculta del motor de render.
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(rendererDir, 'index.html'))
}

app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

app.setAppUserModelId('com.daniel.cancun')

// Una sola ventana de Cancun: si ya está abierta, se trae al frente.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  protocol.handle('media', serveMedia)
  registerIpc()
  syncFromCapCut().catch(() => undefined)
  await startBridge(handleBridge)
  createWindow()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => stopChat())
