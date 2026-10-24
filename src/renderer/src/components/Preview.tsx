import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resolveClip } from '@shared/animate'
import { type Clip, type Project, US, clipEnd, findClip, projectDuration } from '@shared/project'
import { primarySelection, useEditor } from '../store'
import { Player } from '../engine/Player'
import { timecode } from '../format'
import { Icon } from './icons'

let player: Player | null = null
/** Acceso al reproductor para el puente del CLI (captura de cuadros). */
export const getPlayer = (): Player | null => player

const RATIOS: { label: string; w: number; h: number }[] = [
  { label: '16:9', w: 1920, h: 1080 },
  { label: '9:16', w: 1080, h: 1920 },
  { label: '1:1', w: 1080, h: 1080 },
  { label: '4:3', w: 1440, h: 1080 },
  { label: '3:4', w: 1080, h: 1440 },
  { label: '4:5', w: 1080, h: 1350 },
  { label: '21:9', w: 2560, h: 1080 }
]

const QUALITIES = [
  { label: 'Calidad alta', width: 1920 },
  { label: 'Calidad media', width: 1280 },
  { label: 'Calidad rápida', width: 854 }
]

function readQuality(): number {
  try {
    return Number(localStorage.getItem('cancun.previewQuality')) || 1280
  } catch {
    return 1280
  }
}

function Timecode() {
  const time = useEditor((s) => s.time)
  const project = useEditor((s) => s.project!)
  const fps = project.canvas.fps
  return (
    <span className="timecode">
      <span className="cur">{timecode(time, fps)}</span> / {timecode(projectDuration(project), fps)}
    </span>
  )
}

/** Rectángulo del clip en píxeles del lienzo del proyecto. */
function clipBox(p: Project, clip: Clip): { w: number; h: number } | null {
  if (clip.type === 'effect' || clip.type === 'adjust') return null
  const t = clip.transform
  if (clip.type === 'media') {
    const m = p.media[clip.mediaId]
    if (!m || m.kind === 'audio') return null
    const fit = Math.min(p.canvas.width / (m.width ?? 1), p.canvas.height / (m.height ?? 1))
    const cw = (m.width ?? 1) * (1 - clip.crop.left - clip.crop.right)
    const ch = (m.height ?? 1) * (1 - clip.crop.top - clip.crop.bottom)
    return { w: cw * fit * t.scale, h: ch * fit * (t.scaleY ?? t.scale) }
  }
  const size = (clip.style.size * p.canvas.height) / 1080
  const lines = clip.text.split('\n')
  return { w: Math.max(40, Math.max(...lines.map((l) => l.length)) * size * 0.55) * t.scale, h: size * 1.25 * lines.length * (t.scaleY ?? t.scale) }
}

/**
 * Recuadro del clip seleccionado: se arrastra para moverlo, las esquinas lo escalan y
 * el círculo de abajo lo gira. Las guías aparecen al pasar por el centro del lienzo.
 */
function SelectionBox({ project, box }: { project: Project; box: { w: number; h: number } }) {
  const id = useEditor(primarySelection)
  const time = useEditor((s) => s.time)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  if (!id) return null
  const found = findClip(project, id)
  if (!found || found.clip.start > time || clipEnd(found.clip) <= time) return null
  const clip = resolveClip(found.clip, time)
  const size = clipBox(project, clip)
  if (!size) return null
  const k = box.w / project.canvas.width
  const w = size.w * k
  const h = size.h * k
  const cx = box.w / 2 + (clip.transform.x * box.w) / 2
  const cy = box.h / 2 + (clip.transform.y * box.h) / 2
  const base = found.clip

  const gesture = (e: React.PointerEvent, kind: 'move' | 'scale' | 'rotate') => {
    e.preventDefault()
    e.stopPropagation()
    const s = useEditor.getState()
    const start = s.project!
    const t0 = base.transform
    const rect = (e.currentTarget.closest('.preview-overlay') as HTMLElement).getBoundingClientRect()
    const center = { x: rect.left + cx, y: rect.top + cy }
    const d0 = Math.hypot(e.clientX - center.x, e.clientY - center.y)
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) => {
      let patch
      if (kind === 'move') {
        let x = t0.x + ((ev.clientX - sx) / box.w) * 2
        let y = t0.y + ((ev.clientY - sy) / box.h) * 2
        const snapX = Math.abs(x) < 0.02
        const snapY = Math.abs(y) < 0.02
        if (snapX) x = 0
        if (snapY) y = 0
        setGuides({ v: snapX, h: snapY })
        patch = { transform: { x, y } }
      } else if (kind === 'scale') {
        const f = Math.hypot(ev.clientX - center.x, ev.clientY - center.y) / Math.max(1, d0)
        patch = { transform: { scale: Math.max(0.02, t0.scale * f), scaleY: t0.scaleY === null ? null : Math.max(0.02, t0.scaleY * f) } }
      } else {
        const a = (Math.atan2(ev.clientY - center.y, ev.clientX - center.x) * 180) / Math.PI + 90
        let r = ((a + 540) % 360) - 180
        for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(r - snap) < 3) r = snap
        patch = { transform: { rotation: Math.round(r * 10) / 10 } }
      }
      useEditor.getState().preview(start, { op: 'updateClip', clipId: base.id, patch })
    }
    const up = () => {
      setGuides({ v: false, h: false })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      {guides.v && <div className="guide v" style={{ left: box.w / 2 }} />}
      {guides.h && <div className="guide h" style={{ top: box.h / 2 }} />}
      <div
        className="sel-box"
        style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${clip.transform.rotation}deg)` }}
        onPointerDown={(e) => gesture(e, 'move')}
        onWheel={(e) => {
          const scale = Math.max(0.02, Math.min(10, base.transform.scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05)))
          useEditor.getState().dispatch({ op: 'updateClip', clipId: base.id, patch: { transform: { scale } } })
        }}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
          <span key={c} className={`corner ${c}`} onPointerDown={(e) => gesture(e, 'scale')} />
        ))}
        <span className="rotator" onPointerDown={(e) => gesture(e, 'rotate')} title="Girar">
          <Icon name="rotate" size={12} />
        </span>
      </div>
    </>
  )
}

/** Controles sobre la imagen en pantalla completa; se esconden si el mouse no se mueve. */
function FullscreenControls({ onExit }: { onExit: () => void }) {
  const playing = useEditor((s) => s.playing)
  const time = useEditor((s) => s.time)
  const project = useEditor((s) => s.project!)
  const [visible, setVisible] = useState(true)
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null)
  const total = projectDuration(project)
  const fps = project.canvas.fps
  useEffect(() => {
    const show = () => {
      setVisible(true)
      if (hide.current) clearTimeout(hide.current)
      hide.current = setTimeout(() => setVisible(false), 2500)
    }
    show()
    window.addEventListener('pointermove', show)
    return () => {
      window.removeEventListener('pointermove', show)
      if (hide.current) clearTimeout(hide.current)
    }
  }, [])
  const s = useEditor.getState
  return (
    <div className={`fs-controls ${visible ? '' : 'hidden'}`} onPointerDown={(e) => e.stopPropagation()}>
      <input
        className="fs-progress"
        type="range"
        min={0}
        max={Math.max(1, total)}
        step={US / fps}
        value={time}
        onChange={(e) => s().seek(Number(e.target.value))}
      />
      <div className="fs-row">
        <span className="timecode">
          <span className="cur">{timecode(time, fps)}</span> / {timecode(total, fps)}
        </span>
        <div className="fs-buttons">
          <button className="icon-btn" title="Atrás 5 s" onClick={() => s().seek(s().time - 5 * US)}>
            <Icon name="skipBack" />
          </button>
          <button className="icon-btn" title="Cuadro anterior" onClick={() => s().seek(s().time - US / fps)}>
            <Icon name="chevronLeft" />
          </button>
          <button className="play-btn" title="Reproducir / pausar (Espacio)" onClick={() => s().setPlaying(!playing)}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button className="icon-btn" title="Cuadro siguiente" onClick={() => s().seek(s().time + US / fps)}>
            <Icon name="chevronRight" />
          </button>
          <button className="icon-btn" title="Adelante 5 s" onClick={() => s().seek(s().time + 5 * US)}>
            <Icon name="skipForward" />
          </button>
        </div>
        <button className="icon-btn" title="Salir de pantalla completa (Esc)" onClick={onExit}>
          <Icon name="minimize" />
        </button>
      </div>
    </div>
  )
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const project = useEditor((s) => s.project!)
  const playing = useEditor((s) => s.playing)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const [quality, setQuality] = useState(readQuality)

  useEffect(() => {
    const p = new Player(
      canvasRef.current!,
      (t) => useEditor.setState({ time: Math.round(t) }),
      () => useEditor.getState().setPlaying(false)
    )
    player = p
    p.setQuality(readQuality())
    p.setProject(useEditor.getState().project!)
    p.seek(useEditor.getState().time)
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.project && s.project !== prev.project) p.setProject(s.project)
      if (s.playing !== prev.playing) (s.playing ? p.play() : p.pause())
      // Al pasar el mouse por la línea de tiempo se muestra ese cuadro; al salir, vuelve al cursor.
      const shown = !s.playing && s.hoverTime !== null ? s.hoverTime : s.time
      const before = !prev.playing && prev.hoverTime !== null ? prev.hoverTime : prev.time
      if (shown !== before) p.seek(shown)
    })
    const onFs = () => setFullscreen(document.fullscreenElement === panelRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      unsub()
      document.removeEventListener('fullscreenchange', onFs)
      p.destroy()
      player = null
    }
  }, [])

  // Encaja el lienzo dentro del escenario respetando la proporción.
  useLayoutEffect(() => {
    const stage = stageRef.current!
    const fit = () => {
      const r = stage.getBoundingClientRect()
      const pad = fullscreen ? 0 : 16
      const ar = project.canvas.width / project.canvas.height
      let w = r.width - pad * 2
      let h = w / ar
      if (h > r.height - pad * 2) {
        h = r.height - pad * 2
        w = h * ar
      }
      setBox({ w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [project.canvas.width, project.canvas.height, fullscreen])

  const ratio = RATIOS.find((r) => Math.abs(r.w / r.h - project.canvas.width / project.canvas.height) < 0.01)

  return (
    <div className={`panel preview-panel ${fullscreen ? 'is-fullscreen' : ''}`} ref={panelRef}>
      {!fullscreen && <div className="preview-head">Reproductor · Línea de tiempo 01</div>}
      <div
        className="preview-stage"
        ref={stageRef}
        onPointerDown={(e) => e.target === e.currentTarget && useEditor.getState().select(null)}
        onDoubleClick={(e) => e.target === e.currentTarget && void panelRef.current?.requestFullscreen()}
      >
        <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} />
        {!fullscreen && (
          <div className="preview-overlay" style={{ width: box.w, height: box.h }}>
            <SelectionBox project={project} box={box} />
          </div>
        )}
        {fullscreen && <FullscreenControls onExit={() => void document.exitFullscreen()} />}
      </div>
      {!fullscreen && (
        <div className="preview-bar">
          <Timecode />
          <button className="play-btn" title="Reproducir / pausar (Espacio)" onClick={() => useEditor.getState().setPlaying(!playing)}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <div className="right">
            <select
              className="num"
              style={{ width: 120, textAlign: 'left' }}
              value={quality}
              title="Calidad de la vista previa (no afecta la exportación)"
              onChange={(e) => {
                const q = Number(e.target.value)
                setQuality(q)
                player?.setQuality(q)
                try {
                  localStorage.setItem('cancun.previewQuality', String(q))
                } catch {
                  /* sin almacenamiento local */
                }
              }}
            >
              {QUALITIES.map((q) => (
                <option key={q.width} value={q.width}>
                  {q.label}
                </option>
              ))}
            </select>
            <select
              className="num"
              style={{ width: 80, textAlign: 'left' }}
              value={ratio?.label ?? 'custom'}
              title="Relación de aspecto"
              onChange={(e) => {
                const r = RATIOS.find((x) => x.label === e.target.value)
                if (r) useEditor.getState().dispatch({ op: 'setCanvas', width: r.w, height: r.h })
              }}
            >
              {!ratio && <option value="custom">{`${project.canvas.width}×${project.canvas.height}`}</option>}
              {RATIOS.map((r) => (
                <option key={r.label} value={r.label}>
                  {r.label}
                </option>
              ))}
            </select>
            <button className="icon-btn" title="Pantalla completa (doble clic en la imagen)" onClick={() => void panelRef.current?.requestFullscreen()}>
              <Icon name="fit" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
