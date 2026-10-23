// Chat con Claude dentro de Cancun. Usa Claude Code instalado en el equipo (`claude`),
// con la sesión de Daniel, así que no hace falta una clave de API aparte. Claude edita
// con el CLI `cancun`, por eso cada cambio se ve en vivo en la ventana.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** El ejecutable nativo de Claude Code (instalado con npm); sin shell, para pasar bien los argumentos. */
function claudeExe(): string {
  const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  return existsSync(exe) ? exe : 'claude.exe'
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

export function sendChat(text: string, ctx: ChatContext, cwd: string, emit: (e: ChatEvent) => void) {
  if (child) throw new Error('Claude todavía está respondiendo')
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
  if (sessionId) args.push('--resume', sessionId)
  emit({ type: 'start' })
  const proc = spawn(claudeExe(), args, { cwd, windowsHide: true, env: { ...process.env } })
  child = proc
  let buf = ''
  let err = ''
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
          if (block.type === 'text' && block.text) emit({ type: 'text', text: block.text })
          if (block.type === 'tool_use') emit({ type: 'tool', tool: toolLabel(block.name ?? '', block.input ?? {}) })
        }
      } else if (msg.type === 'result' && msg.is_error) {
        emit({ type: 'error', error: String(msg.result ?? 'Error') })
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

export function stopChat() {
  child?.kill()
  child = null
}

export function resetChat() {
  stopChat()
  sessionId = null
}
