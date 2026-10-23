#!/usr/bin/env node
// CLI de Cancun: habla con la app abierta por un WebSocket local, así cada edición
// se ve en vivo en la ventana. Los tiempos se escriben en SEGUNDOS.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INFO = join(process.env.APPDATA ?? '', 'Cancun', 'bridge.json')
const US = 1_000_000
// Campos de las operaciones que son tiempos (se convierten de segundos a µs).
const TIME_FIELDS = new Set(['start', 'duration', 'sourceIn', 'time', 'at', 'fadeIn', 'fadeOut'])

const HELP = `cancun — controla el editor Cancun desde la terminal (tiempos en segundos)

Conexión
  cancun launch                       abre la app (si no está abierta)
  cancun status                       ¿está abierta? ¿qué proyecto?
  cancun projects                     lista los proyectos guardados
  cancun open <id>                    abre un proyecto en la ventana
  cancun new <nombre> [--size 1080x1920] [--fps 30]

Leer
  cancun summary                      resumen compacto (pistas, clips, medios)
  cancun state                        proyecto completo en JSON
  cancun luts                         LUTs disponibles (rutas para setLut)
  cancun frame [--time 3.5] [--out f.png]   guarda el cuadro como PNG y muestra la ruta
  cancun screenshot [--out f.png]     captura la ventana completa de Cancun

Editar (se ve en vivo; Ctrl+Z en la app deshace el lote completo)
  cancun import <archivos...> [--add] importa medios; --add los pone en la línea de tiempo
  cancun apply '<json>'               aplica una operación o una lista de operaciones
  cancun apply --file ops.json        igual, desde un archivo
  cancun ops                          referencia de operaciones
  cancun undo | redo
  cancun seek <seg> | play | pause | select <clipId>

Exportar
  cancun export <salida.mp4>          exporta con la configuración del proyecto`

const OPS = `Operaciones (campo "op"). Tiempos en segundos; ids salen de "cancun summary".

{"op":"addClip","mediaId":ID,"trackId?":ID,"start?":s,"sourceIn?":s,"duration?":s}
    video/imagen sin start → al final de la pista principal (magnética)
{"op":"addText","text":"Hola","start":s,"duration?":s,"style?":{"size":72,"color":"#fff","font":"Arial","bold":true,"strokeWidth":1,"strokeColor":"#000","background":null,"align":"center"}}
{"op":"addTrack","kind":"video|audio|text"}
{"op":"moveClip","clipId":ID,"start":s,"trackId?":ID}
{"op":"trimClip","clipId":ID,"side":"start|end","time":s}      (time = instante de la línea de tiempo)
{"op":"splitClip","clipId":ID,"at":s}
{"op":"deleteClip","clipId":ID}
{"op":"setLut","clipId":ID,"lut":{"path":RUTA,"name":"Her","intensity":0.8}}   lut:null para quitar
{"op":"setTransition","clipId":ID,"transition":{"kind":"fade","duration":0.5}}  con el clip SIGUIENTE pegado
    kinds: fade dissolve fadeblack fadewhite slideleft slideright slideup slidedown wipeleft wiperight
           circleopen circleclose zoomin radial pixelize smoothleft
{"op":"updateClip","clipId":ID,"patch":{...}}  parche parcial, por ejemplo:
    {"transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1}}   x,y: -1..1 = borde a borde
    {"color":{"adjust":{"brightness":0,"contrast":0,"saturation":0,"exposure":0,"temperature":0,"tint":0,"highlights":0,"shadows":0,"sharpen":0,"vignette":0}}}  (-1..1)
    {"volume":1}  (ganancia lineal, 0 = silencio)   {"fadeIn":0.5,"fadeOut":1}   {"speed":2}
    {"audioFx":{"normalize":true,"denoise":true,"enhanceVoice":true,"isolateVoice":false}}
    {"background":{"mode":"chroma","chroma":{"color":"#00ff00","intensity":0.4,"shadow":0.1}}}
    texto: {"text":"...","style":{...}}
{"op":"updateTrack","trackId":ID,"patch":{"muted":true,"hidden":false,"locked":false}}
{"op":"setCanvas","width":1080,"height":1920,"fps":30,"background":"#000000"}
{"op":"setExport","patch":{"codec":"h264|hevc","bitrate":12000,"fps":30,"hardware":true}}   bitrate en kbps (null = recomendado)
{"op":"rename","name":"..."}`

function toMicro(value, key) {
  if (Array.isArray(value)) return value.map((v) => toMicro(v))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'transition' && v && typeof v === 'object') out[k] = { ...v, duration: Math.round(v.duration * US) }
      else out[k] = toMicro(v, k)
    }
    return out
  }
  if (typeof value === 'number' && TIME_FIELDS.has(key)) return Math.round(value * US)
  return value
}

function fromMicro(value, key) {
  if (Array.isArray(value)) return value.map((v) => fromMicro(v))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = fromMicro(v, k)
    return out
  }
  if (typeof value === 'number' && (TIME_FIELDS.has(key) || key === 'duration')) return value / US
  return value
}

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

function hasFlag(args, name) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}

function connect() {
  if (!existsSync(INFO)) throw new Error('Cancun no está abierto. Ejecuta: cancun launch')
  const { port, token } = JSON.parse(readFileSync(INFO, 'utf8'))
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    ws.onopen = () => ok(ws)
    ws.onerror = () => fail(new Error('Cancun no está abierto (o se cerró). Ejecuta: cancun launch'))
  })
}

async function call(method, params = {}) {
  const ws = await connect()
  return new Promise((ok, fail) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      ws.close()
      if (msg.error) fail(new Error(msg.error))
      else ok(msg.result)
    }
    ws.onclose = (e) => {
      if (e.code === 4401) fail(new Error('Token inválido: reinicia Cancun'))
    }
    ws.send(JSON.stringify({ id: 1, method, params }))
  })
}

const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))

async function waitForApp(ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      await call('current')
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return false
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args.shift()
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return print(HELP)
    case 'ops':
      return print(OPS)
    case 'launch': {
      try {
        await call('current')
        return print('Cancun ya está abierto.')
      } catch {
        /* se abre abajo */
      }
      const electron = join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
      if (!existsSync(join(APP_DIR, 'out', 'main', 'index.js'))) throw new Error('Falta compilar la app: npm run build (en la carpeta de Cancun)')
      const child = spawn(electron, [APP_DIR], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return print((await waitForApp()) ? 'Cancun abierto.' : 'Se lanzó Cancun pero aún no responde.')
    }
    case 'status': {
      try {
        const cur = await call('current')
        return print({ open: true, project: cur })
      } catch (e) {
        return print({ open: false, reason: e.message })
      }
    }
    case 'projects':
      return print(await call('projects'))
    case 'luts':
      return print((await call('luts')).map((l) => ({ name: l.name, path: l.path })))
    case 'open':
      return print(await call('open', { id: args[0] }))
    case 'new': {
      const size = flag(args, 'size', '1920x1080')
      const fps = Number(flag(args, 'fps', '30'))
      const [width, height] = size.split('x').map(Number)
      return print(await call('new', { name: args.join(' ') || 'Proyecto', width, height, fps }))
    }
    case 'summary':
      return print(await call('summary'))
    case 'state':
      return print(fromMicro(await call('state')))
    case 'import': {
      const add = hasFlag(args, 'add')
      return print(await call('import', { paths: args.map((p) => resolve(p)), add }))
    }
    case 'apply': {
      const file = flag(args, 'file')
      const raw = file ? readFileSync(file, 'utf8') : args.length ? args.join(' ') : readFileSync(0, 'utf8')
      const parsed = JSON.parse(raw)
      const ops = (Array.isArray(parsed) ? parsed : [parsed]).map((op) => toMicro(op))
      return print(await call('apply', { ops }))
    }
    case 'seek':
      return print(await call('seek', { time: Number(args[0]) }))
    case 'play':
    case 'pause':
    case 'undo':
    case 'redo':
      return print(await call(cmd))
    case 'select':
      return print(await call('select', { clipId: args[0] ?? null }))
    case 'frame': {
      const time = flag(args, 'time')
      const out = resolve(flag(args, 'out', join(tmpdir(), 'cancun', `frame-${Date.now()}.png`)))
      const { png } = await call('frame', time !== undefined ? { time: Number(time) } : {})
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'))
      return print(out)
    }
    case 'screenshot': {
      const out = resolve(flag(args, 'out', join(tmpdir(), 'cancun', `window-${Date.now()}.png`)))
      const { png } = await call('screenshot')
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'))
      return print(out)
    }
    case 'export': {
      const out = resolve(args[0] ?? 'export.mp4')
      return print(await call('export', { output: out }))
    }
    default:
      throw new Error(`Comando desconocido: ${cmd}\n\n${HELP}`)
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`)
  process.exit(1)
})
