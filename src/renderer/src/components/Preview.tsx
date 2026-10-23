import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Project, clipEnd, findClip, projectDuration } from '@shared/project'
import { useEditor } from '../store'
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

/** Recuadro del clip seleccionado: se arrastra para moverlo y la rueda lo escala. */
function SelectionBox({ project, box }: { project: Project; box: { w: number; h: number } }) {
  const selection = useEditor((s) => s.selection)
  const time = useEditor((s) => s.time)
  if (!selection) return null
  const found = findClip(project, selection)
  if (!found || found.clip.start > time || clipEnd(found.clip) <= time) return null
  const clip = found.clip
  let w: number
  let h: number
  if (clip.type === 'media') {
    const m = project.media[clip.mediaId]
    if (!m || m.kind === 'audio') return null
    const fit = Math.min(project.canvas.width / (m.width ?? 1), project.canvas.height / (m.height ?? 1)) * clip.transform.scale
    w = ((m.width ?? 1) * fit * box.w) / project.canvas.width
    h = ((m.height ?? 1) * fit * box.h) / project.canvas.height
  } else {
    const size = (clip.style.size * box.h) / 1080 * clip.transform.scale
    w = Math.max(40, clip.text.length * size * 0.55)
    h = size * 1.3 * clip.text.split('\n').length
  }
  const cx = box.w / 2 + (clip.transform.x * box.w) / 2
  const cy = box.h / 2 + (clip.transform.y * box.h) / 2

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, tx: clip.transform.x, ty: clip.transform.y }
    const s = useEditor.getState()
    let last = s.project!
    const move = (ev: PointerEvent) => {
      // Durante el arrastre se reemplaza el último paso para no llenar el historial.
      const x = start.tx + ((ev.clientX - start.x) / box.w) * 2
      const y = start.ty + ((ev.clientY - start.y) / box.h) * 2
      const snap = (v: number) => (Math.abs(v) < 0.02 ? 0 : v)
      useEditor.setState({ project: last })
      useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch: { transform: { x: snap(x), y: snap(y) } } })
      useEditor.setState((st) => ({ past: st.past.slice(0, -1) }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const final = useEditor.getState().project!
      useEditor.setState((st) => ({ past: [...st.past, last] }))
      last = final
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="sel-box"
      style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${clip.transform.rotation}deg)` }}
      onPointerDown={onPointerDown}
      onWheel={(e) => {
        const scale = Math.max(0.05, Math.min(10, clip.transform.scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05)))
        useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch: { transform: { scale } } })
      }}
    />
  )
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const project = useEditor((s) => s.project!)
  const playing = useEditor((s) => s.playing)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const p = new Player(
      canvasRef.current!,
      (t) => useEditor.setState({ time: Math.round(t) }),
      () => useEditor.getState().setPlaying(false)
    )
    player = p
    p.setProject(useEditor.getState().project!)
    p.seek(useEditor.getState().time)
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.project && s.project !== prev.project) p.setProject(s.project)
      if (s.playing !== prev.playing) (s.playing ? p.play() : p.pause())
      if (s.time !== prev.time) p.seek(s.time)
    })
    return () => {
      unsub()
      p.destroy()
      player = null
    }
  }, [])

  // Encaja el lienzo dentro del escenario respetando la proporción.
  useLayoutEffect(() => {
    const stage = stageRef.current!
    const fit = () => {
      const r = stage.getBoundingClientRect()
      const pad = 16
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
  }, [project.canvas.width, project.canvas.height])

  const ratio = RATIOS.find((r) => Math.abs(r.w / r.h - project.canvas.width / project.canvas.height) < 0.01)

  return (
    <div className="panel">
      <div className="preview-head">Reproductor · Línea de tiempo 01</div>
      <div className="preview-stage" ref={stageRef} onPointerDown={(e) => e.target === e.currentTarget && useEditor.getState().select(null)}>
        <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} />
        <div className="preview-overlay" style={{ width: box.w, height: box.h }}>
          <SelectionBox project={project} box={box} />
        </div>
      </div>
      <div className="preview-bar">
        <Timecode />
        <button className="play-btn" title="Reproducir / pausar (Espacio)" onClick={() => useEditor.getState().setPlaying(!playing)}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <div className="right">
          <select
            className="num"
            style={{ width: 90, textAlign: 'left' }}
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
          <button className="icon-btn" title="Pantalla completa" onClick={() => canvasRef.current?.requestFullscreen()}>
            <Icon name="fit" />
          </button>
        </div>
      </div>
    </div>
  )
}
