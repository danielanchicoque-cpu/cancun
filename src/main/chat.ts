// Chat con Claude dentro de Cancun. Usa Claude Code instalado en el equipo (`claude`),
// con la sesión de Daniel, así que no hace falta una clave de API aparte. Claude edita
// con el CLI `cancun`, por eso cada cambio se ve en vivo en la ventana.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { app } from 'electron'

/** El ejecutable nativo de Claude Code (npm o instalador nativo); sin shell, para pasar bien los argumentos. */
function claudeExe(): string | null {
  const home = process.env.USERPROFILE ?? ''
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(home, '.local', 'bin', 'claude.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe')
  ]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) candidates.push(join(dir, 'claude.exe'))
  return candidates.find((p) => existsSync(p)) ?? null
}

const NOT_INSTALLED = 'Claude Code no está instalado en este equipo. Instálalo desde claude.com/code (o con  npm i -g @anthropic-ai/claude-code ) y vuelve a abrir el chat.'

/**
 * Carpeta de trabajo de Claude (la de la app empaquetada está dentro de app.asar, que no es
 * una carpeta) y un `cancun.cmd` para que Claude pueda usar el CLI aunque no esté instalado con npm.
 */
async function workspace(): Promise<{ cwd: string; path: string }> {
  const cwd = join(app.getPath('userData'), 'claude')
  const bin = join(cwd, 'bin')
  await mkdir(bin, { recursive: true })
  if (app.isPackaged) {
    const cli = join(process.resourcesPath, 'app.asar', 'cli', 'cancun.mjs')
    await writeFile(join(bin, 'cancun.cmd'), `@echo off
set ELECTRON_RUN_AS_NODE=1
"${process.execPath}" "${cli}" %*
`)
  }
  return { cwd, path: `${bin}${delimiter}${process.env.PATH ?? ''}` }
}

export interface ClaudeStatus {
  installed: boolean
  loggedIn: boolean
  email?: string
}

export function claudeStatus(): Promise<ClaudeStatus> {
  const exe = claudeExe()
  if (!exe) return Promise.resolve({ installed: false, loggedIn: false })
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status', '--json'], { windowsHide: true, timeout: 20_000 }, (_err, stdout) => {
      try {
        const s = JSON.parse(stdout) as { loggedIn?: boolean; email?: string }
        resolve({ installed: true, loggedIn: !!s.loggedIn, email: s.email })
      } catch {
        resolve({ installed: true, loggedIn: false })
      }
    })
  })
}

/** Abre una ventana con el inicio de sesión de Claude (abre el navegador; si pide un código, se pega ahí). */
export function claudeLogin() {
  const exe = claudeExe()
  if (!exe) throw new Error(NOT_INSTALLED)
  spawn('cmd.exe', ['/c', 'start', '"Iniciar sesión en Claude"', `"${exe}"`, 'auth', 'login'], { windowsHide: false, detached: true, stdio: 'ignore', shell: false, windowsVerbatimArguments: true }).unref()
}

export interface ChatEvent {
  type: 'text' | 'tool' | 'done' | 'error' | 'start'
  text?: string
  tool?: string
  error?: string
}

export interface ChatContext {
  projectId?: string
  projectName?: string
  time?: number
  selection?: string[]
  /** Alias o nombre completo del modelo (vacío = el predeterminado de Claude Code). */
  model?: string
}

let child: ChildProcess | null = null
let sessionId: string | null = null

const SYSTEM = `Estás integrado dentro de Cancun, el editor de video de Daniel. Él te escribe desde un chat dentro de la app.
Edita su proyecto abierto con el CLI \`cancun\` (sigue la skill "cancun": usa \`cancun summary\`, \`cancun ops\`, \`cancun apply\`, y verifica con \`cancun frame\` antes de decir que algo quedó).
Responde corto y en español, como colega editor. No expliques comandos salvo que te lo pida.`

function describe(ctx: ChatContext): string {
  const parts = [`Proyecto abierto: ${ctx.projectName ?? '(ninguno)'}${ctx.projectId ? ` (id ${ctx.projectId})` : ''}.`]
  if (ctx.time !== undefined) parts.push(`El cursor está en ${ctx.time.toFixed(2)} s.`)
  if (ctx.selection?.length) parts.push(`Clips seleccionados: ${ctx.selection.join(', ')}.`)
  return parts.join(' ')
}

/** Resume el bloque de uso de una herramienta en una línea legible. */
function toolLabel(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') {
    const cmd = String(input.command ?? '')
    const m = /cancun\s+(\w+)/.exec(cmd)
    return m ? `cancun ${m[1]}` : cmd.slice(0, 60)
  }
  if (name === 'Read') return 'mirando un cuadro'
  return name
}

export async function sendChat(text: string, ctx: ChatContext, emit: (e: ChatEvent) => void) {
  if (child) throw new Error('Claude todavía está respondiendo')
  const exe = claudeExe()
  if (!exe) {
    emit({ type: 'error', error: NOT_INSTALLED })
    emit({ type: 'done' })
    return
  }
  const { cwd, path } = await workspace()
  const args = [
    '-p',
    `${describe(ctx)}\n\n${text}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    SYSTEM,
    '--allowedTools',
    'Bash(cancun:*)',
    'Read',
    'Glob',
    'Grep'
  ]
  if (ctx.model) args.push('--model', ctx.model)
  if (sessionId) args.push('--resume', sessionId)
  emit({ type: 'start' })
  const proc = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  let buf = ''
  let err = ''
  let shownText = false
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.session_id === 'string') sessionId = msg.session_id
      if (msg.type === 'assistant') {
        const content = (msg.message as { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] })?.content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            shownText = true
            emit({ type: /not logged in/i.test(block.text) ? 'error' : 'text', text: friendly(block.text), error: friendly(block.text) })
          }
          if (block.type === 'tool_use') emit({ type: 'tool', tool: toolLabel(block.name ?? '', block.input ?? {}) })
        }
      } else if (msg.type === 'result' && msg.is_error && !shownText) {
        emit({ type: 'error', error: friendly(String(msg.result ?? 'Error')) })
      }
    }
  })
  proc.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
  proc.on('error', (e) => emit({ type: 'error', error: `No se pudo abrir Claude Code: ${e.message}` }))
  proc.on('close', (code) => {
    child = null
    if (code && code !== 0 && err.trim()) emit({ type: 'error', error: err.trim() })
    emit({ type: 'done' })
  })
}

/** Mensajes de Claude Code que conviene explicar en español. */
function friendly(text: string): string {
  if (/not logged in/i.test(text)) return 'Claude no tiene sesión iniciada en este equipo. Pulsa «Iniciar sesión» arriba en este panel (una sola vez).'
  return text
}

export function stopChat() {
  child?.kill()
  child = null
}

export function resetChat() {
  stopChat()
  sessionId = null
}
