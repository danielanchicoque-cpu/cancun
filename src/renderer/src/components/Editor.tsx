import { useEffect, useState } from 'react'
import { US } from '@shared/project'
import { useEditor } from '../store'
import { deleteSelection, duplicateSelection, onToast, paste, splitAtPlayhead, trimToPlayhead } from '../actions'
import { LeftPanel } from './LeftPanel'
import { Preview, getPlayer } from './Preview'
import { api } from '../api'
import { Inspector } from './Inspector'
import { Timeline } from './Timeline'
import { ExportDialog } from './ExportDialog'
import { ChatPanel } from './ChatPanel'
import { Icon } from './icons'

function useDrag(onMove: (dx: number, dy: number) => void) {
  return (e: React.PointerEvent) => {
    e.preventDefault()
    let lx = e.clientX
    let ly = e.clientY
    const move = (ev: PointerEvent) => {
      onMove(ev.clientX - lx, ev.clientY - ly)
      lx = ev.clientX
      ly = ev.clientY
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
}

function SaveIndicator() {
  const save = useEditor((s) => s.save)
  const error = useEditor((s) => s.saveError)
  const label = { saved: 'Guardado', pending: 'Cambios…', saving: 'Guardando…', error: 'Error al guardar' }[save]
  return (
    <span className={`save-state ${save === 'error' ? 'error' : ''}`} title={error ?? 'Guardado automático'}>
      {label}
    </span>
  )
}

/** Guarda un cuadro como portada del proyecto (para la lista del inicio) cada tanto y al salir. */
function useCover() {
  useEffect(() => {
    let last: unknown = null
    const save = () => {
      const { project } = useEditor.getState()
      const player = getPlayer()
      if (!project || !player || project === last) return
      last = project
      try {
        void api.saveCover(project.id, player.snapshot()).catch(() => undefined)
      } catch {
        // El lienzo todavía no está listo.
      }
    }
    const t = setInterval(save, 20_000)
    const first = setTimeout(save, 3000)
    return () => {
      clearInterval(t)
      clearTimeout(first)
      save()
    }
  }, [])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return
      const s = useEditor.getState()
      const fps = s.project?.canvas.fps ?? 30
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (e.code === 'Space') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if (ctrl && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (ctrl && key === 'y') {
        e.preventDefault()
        s.redo()
      } else if (ctrl && key === 'b') {
        e.preventDefault()
        splitAtPlayhead()
      } else if (ctrl && key === 'd') {
        e.preventDefault()
        duplicateSelection()
      } else if (ctrl && key === 'c') {
        s.copy()
      } else if (ctrl && key === 'v') {
        e.preventDefault()
        paste()
      } else if (ctrl && key === 'a') {
        e.preventDefault()
        s.select(s.project!.tracks.flatMap((t) => t.clips.map((c) => c.id)))
      } else if (!ctrl && key === 'q') {
        trimToPlayhead('left')
      } else if (!ctrl && key === 'w') {
        trimToPlayhead('right')
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelection()
      } else if (e.key === 'ArrowLeft') {
        s.seek(s.time - (e.shiftKey ? US : US / fps))
      } else if (e.key === 'ArrowRight') {
        s.seek(s.time + (e.shiftKey ? US : US / fps))
      } else if (e.key === 'Home') {
        s.seek(0)
      } else if (e.key === 'End') {
        s.seek(Number.MAX_SAFE_INTEGER)
      } else if (e.key === '+' || e.key === '=') {
        s.setZoom(s.zoom * 1.25)
      } else if (e.key === '-') {
        s.setZoom(s.zoom / 1.25)
      } else if (e.key === 'Escape') {
        s.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

type Sizes = { left: number; right: number; timeline: number; chat: number; previewW: number }
const DEFAULT_SIZES: Sizes = { left: 500, right: 360, timeline: 330, chat: 380, previewW: 520 }

/** Cada vista (horizontal / vertical) recuerda sus propios tamaños de paneles. */
function readSizes(layout: string): Sizes {
  try {
    return { ...DEFAULT_SIZES, ...(JSON.parse(localStorage.getItem(`cancun.sizes.${layout}`) ?? '{}') as Partial<Sizes>) }
  } catch {
    return DEFAULT_SIZES
  }
}

export function Editor() {
  const name = useEditor((s) => s.project!.name)
  const layout = useEditor((s) => s.layout)
  const chatOpen = useEditor((s) => s.chatOpen)
  const [exporting, setExporting] = useState(false)
  const [size, setSize] = useState(() => readSizes(layout))
  const [sizeLayout, setSizeLayout] = useState(layout)
  if (sizeLayout !== layout) {
    setSizeLayout(layout)
    setSize(readSizes(layout))
  }
  useEffect(() => {
    try {
      localStorage.setItem(`cancun.sizes.${sizeLayout}`, JSON.stringify(size))
    } catch {
      // Sin almacenamiento: los tamaños solo duran esta sesión.
    }
  }, [size, sizeLayout])
  const [toastMsg, setToastMsg] = useState<{ msg: string; error: boolean } | null>(null)
  useShortcuts()
  useCover()
  useEffect(() => onToast((msg, error) => setToastMsg(msg ? { msg, error } : null)), [])

  const dragLeft = useDrag((dx) => setSize((l) => ({ ...l, left: Math.max(300, Math.min(900, l.left + dx)) })))
  const dragRight = useDrag((dx) => setSize((l) => ({ ...l, right: Math.max(280, Math.min(700, l.right - dx)) })))
  const dragPreview = useDrag((dx) => setSize((l) => ({ ...l, previewW: Math.max(320, Math.min(1100, l.previewW - dx)) })))
  const dragTimeline = useDrag((_dx, dy) => setSize((l) => ({ ...l, timeline: Math.max(160, Math.min(window.innerHeight - 320, l.timeline - dy)) })))
  const vars = {
    ['--left-w' as string]: `${size.left}px`,
    ['--right-w' as string]: `${size.right}px`,
    ['--timeline-h' as string]: `${size.timeline}px`,
    ['--preview-w' as string]: `${size.previewW}px`,
    ['--chat-w' as string]: chatOpen ? `${size.chat}px` : '0px'
  }

  return (
    <div className={`editor layout-${layout} ${chatOpen ? 'with-chat' : ''}`} style={vars}>
      <div className="topbar">
        <button className="icon-btn" title="Volver a los proyectos" onClick={() => useEditor.getState().close()}>
          <Icon name="back" />
        </button>
        <img src="./mark.png" alt="" className="top-mark" />
        <span className="logo">Cancún</span>
        <div className="layout-switch">
          <button className={layout === 'default' ? 'active' : ''} title="Vista horizontal" onClick={() => useEditor.getState().setLayout('default')}>
            <Icon name="layout" size={15} />
          </button>
          <button className={layout === 'vertical' ? 'active' : ''} title="Vista para videos verticales" onClick={() => useEditor.getState().setLayout('vertical')}>
            <Icon name="layoutVertical" size={15} />
          </button>
        </div>
        <input className="title" value={name} onChange={(e) => useEditor.getState().dispatch({ op: 'rename', name: e.target.value })} />
        <SaveIndicator />
        <button className={`btn claude-btn ${chatOpen ? 'on' : ''}`} title="Hablar con Claude" onClick={() => useEditor.getState().toggleChat()}>
          <Icon name="chat" size={14} /> Claude
        </button>
        <button className="btn primary" onClick={() => setExporting(true)}>
          <Icon name="export" size={13} /> Exportar
        </button>
      </div>
      {layout === 'default' ? (
        <>
          <div className="workspace">
            <LeftPanel />
            <div className="splitter-v" onPointerDown={dragLeft} />
            <Preview />
            <div className="splitter-v" onPointerDown={dragRight} />
            <Inspector />
          </div>
          <div className="splitter-h" onPointerDown={dragTimeline} />
          <Timeline />
        </>
      ) : (
        // Vista vertical: el reproductor ocupa toda la altura a la derecha.
        <div className="vertical-body">
          <div className="vertical-left">
            <div className="workspace">
              <LeftPanel />
              <div className="splitter-v" onPointerDown={dragLeft} />
              <Inspector />
            </div>
            <div className="splitter-h" onPointerDown={dragTimeline} />
            <Timeline />
          </div>
          <div className="splitter-v" onPointerDown={dragPreview} />
          <div className="vertical-preview">
            <Preview />
          </div>
        </div>
      )}
      {chatOpen && <ChatPanel />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {toastMsg && <div className={`toast ${toastMsg.error ? 'error' : ''}`}>{toastMsg.msg}</div>}
    </div>
  )
}
