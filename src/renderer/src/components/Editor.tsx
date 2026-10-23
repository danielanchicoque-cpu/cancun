import { useEffect, useRef, useState } from 'react'
import { US } from '@shared/project'
import { useEditor } from '../store'
import { deleteSelection, onToast, splitAtPlayhead } from '../actions'
import { LeftPanel } from './LeftPanel'
import { Preview } from './Preview'
import { Inspector } from './Inspector'
import { Timeline } from './Timeline'
import { ExportDialog } from './ExportDialog'
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

export function Editor() {
  const name = useEditor((s) => s.project!.name)
  const [exporting, setExporting] = useState(false)
  const [layout, setLayout] = useState({ left: 520, right: 360, timeline: 330 })
  const [toastMsg, setToastMsg] = useState<{ msg: string; error: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => onToast((msg, error) => setToastMsg(msg ? { msg, error } : null)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return
      const s = useEditor.getState()
      const fps = s.project?.canvas.fps ?? 30
      const ctrl = e.ctrlKey || e.metaKey
      if (e.code === 'Space') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (ctrl && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if (ctrl && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        splitAtPlayhead()
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

  const dragLeft = useDrag((dx) => setLayout((l) => ({ ...l, left: Math.max(300, Math.min(900, l.left + dx)) })))
  const dragRight = useDrag((dx) => setLayout((l) => ({ ...l, right: Math.max(280, Math.min(700, l.right - dx)) })))
  const dragTimeline = useDrag((_dx, dy) =>
    setLayout((l) => ({ ...l, timeline: Math.max(160, Math.min(window.innerHeight - 320, l.timeline - dy)) }))
  )

  return (
    <div
      ref={root}
      className="editor"
      style={{ ['--left-w' as string]: `${layout.left}px`, ['--right-w' as string]: `${layout.right}px`, ['--timeline-h' as string]: `${layout.timeline}px` }}
    >
      <div className="topbar">
        <button className="icon-btn" title="Volver a los proyectos" onClick={() => useEditor.getState().close()}>
          <Icon name="back" />
        </button>
        <span className="logo">Cancun</span>
        <input
          className="title"
          value={name}
          onChange={(e) => useEditor.getState().dispatch({ op: 'rename', name: e.target.value })}
        />
        <SaveIndicator />
        <button className="btn primary" onClick={() => setExporting(true)}>
          <Icon name="export" size={13} /> Exportar
        </button>
      </div>
      <div className="workspace">
        <LeftPanel />
        <div className="splitter-v" onPointerDown={dragLeft} />
        <Preview />
        <div className="splitter-v" onPointerDown={dragRight} />
        <Inspector />
      </div>
      <div className="splitter-h" onPointerDown={dragTimeline} />
      <Timeline />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {toastMsg && <div className={`toast ${toastMsg.error ? 'error' : ''}`}>{toastMsg.msg}</div>}
    </div>
  )
}
