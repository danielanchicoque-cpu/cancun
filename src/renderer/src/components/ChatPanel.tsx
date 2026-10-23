// Chat con Claude dentro de Cancun. Claude edita el proyecto abierto con el CLI, así
// que cada cambio aparece en vivo en la línea de tiempo y en la vista previa.

import { useEffect, useRef, useState } from 'react'
import { US } from '@shared/project'
import { useEditor } from '../store'
import { api } from '../api'
import { Icon } from './icons'

interface Message {
  role: 'user' | 'claude' | 'tool' | 'error'
  text: string
}

const SUGGESTIONS = [
  'Ponle el LUT Her al 80% a todos los clips',
  'Corta los silencios largos',
  'Agrega un título al inicio que diga "Hola"',
  'Pon transiciones suaves entre todos los clips'
]

let history: Message[] = []

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>(history)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    history = messages
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  useEffect(
    () =>
      api.onChatEvent((e) => {
        if (e.type === 'start') setBusy(true)
        else if (e.type === 'done') setBusy(false)
        else if (e.type === 'text' && e.text) setMessages((m) => [...m, { role: 'claude', text: e.text! }])
        else if (e.type === 'tool' && e.tool) setMessages((m) => [...m, { role: 'tool', text: e.tool! }])
        else if (e.type === 'error') setMessages((m) => [...m, { role: 'error', text: e.error ?? 'Error' }])
      }),
    []
  )

  async function send(value = text) {
    const msg = value.trim()
    if (!msg || busy) return
    setText('')
    setMessages((m) => [...m, { role: 'user', text: msg }])
    const s = useEditor.getState()
    try {
      await api.chatSend(msg, {
        projectId: s.project?.id,
        projectName: s.project?.name,
        time: s.time / US,
        selection: s.selection
      })
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', text: err instanceof Error ? err.message : String(err) }])
    }
  }

  return (
    <aside className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">
          <span className="claude-dot" /> Claude
        </span>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="Conversación nueva"
          onClick={() => {
            void api.chatReset()
            setMessages([])
          }}
        >
          <Icon name="plus" size={14} />
        </button>
        <button className="icon-btn" title="Cerrar" onClick={() => useEditor.getState().toggleChat(false)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Pídeme cambios en tu proyecto y los verás en vivo.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip-suggest" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'tool' ? (
            <div key={i} className="chat-tool">
              <Icon name="scissors" size={11} /> {m.text}
            </div>
          ) : (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.text}
            </div>
          )
        )}
        {busy && <div className="chat-typing">Claude está editando…</div>}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={text}
          placeholder="Escribe lo que quieres que haga…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <button type="button" className="icon-btn" title="Detener" onClick={() => void api.chatStop()}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="icon-btn send" title="Enviar (Enter)" disabled={!text.trim()}>
            <Icon name="send" />
          </button>
        )}
      </form>
    </aside>
  )
}
