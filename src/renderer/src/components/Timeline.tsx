import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Clip, type MediaClip, type Project, type Track, type TransitionKind, US, clipEnd, findClip, projectDuration } from '@shared/project'
import { useEditor } from '../store'
import { useFilmstrip, useWaveform } from '../assets'
import { DEFAULT_TRANSITION_US, addToTimeline, applyTransition, deleteSelection, importFiles, splitAtPlayhead, toast } from '../actions'
import { api } from '../api'
import { shortTime } from '../format'
import { TRANSITIONS } from './LeftPanel'
import { Icon } from './icons'

const RULER_H = 26
const SNAP_PX = 8
const HEIGHT: Record<Track['kind'] | 'main', number> = { main: 70, video: 58, audio: 46, text: 32 }

const trackHeight = (p: Project, t: Track) => (p.tracks[0] === t ? HEIGHT.main : HEIGHT[t.kind])

/** Orden visual como CapCut: capas encima de la principal, audio debajo. */
function displayOrder(p: Project): Track[] {
  const overlays = p.tracks.slice(1).filter((t) => t.kind !== 'audio').reverse()
  const audio = p.tracks.slice(1).filter((t) => t.kind === 'audio')
  return [...overlays, p.tracks[0], ...audio]
}

function Ruler({ zoom, width, scrollLeft, onSeek }: { zoom: number; width: number; scrollLeft: number; onSeek: (x: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const cv = ref.current!
    const dpr = window.devicePixelRatio || 1
    const viewW = cv.parentElement!.parentElement!.clientWidth
    cv.width = viewW * dpr
    cv.height = RULER_H * dpr
    cv.style.width = `${viewW}px`
    const ctx = cv.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, viewW, RULER_H)
    // Paso de las marcas: el menor que deje al menos 80 px entre etiquetas.
    const steps = [1 / 30, 1 / 10, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    const major = steps.find((s) => s * zoom >= 80) ?? 600
    const minor = major / 5
    ctx.strokeStyle = '#4a4a50'
    ctx.fillStyle = '#8a8a90'
    ctx.font = '10px Segoe UI'
    // Se itera por índice entero para no acumular error de coma flotante.
    const first = Math.floor(scrollLeft / zoom / minor)
    for (let i = first; i * minor * zoom - scrollLeft < viewW; i++) {
      const s = Math.round(i * minor * 1e6) / 1e6
      const x = Math.round(s * zoom - scrollLeft) + 0.5
      const isMajor = i % 5 === 0
      ctx.beginPath()
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, RULER_H - (isMajor ? 10 : 5))
      ctx.stroke()
      if (isMajor) ctx.fillText(major < 1 ? `${shortTime(s * US)}.${Math.round((s % 1) * 30)}f` : shortTime(s * US), x + 3, 11)
    }
  }, [zoom, width, scrollLeft])
  return (
    <div className="ruler" style={{ width }} onPointerDown={(e) => onSeek(e.clientX)}>
      <canvas ref={ref} style={{ position: 'sticky', left: 0 }} />
    </div>
  )
}

function Waveform({ peaks, from, to, width, color }: { peaks: number[]; from: number; to: number; width: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const cv = ref.current!
    const w = Math.max(1, Math.min(8000, Math.round(width)))
    const h = cv.clientHeight || 30
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = color
    const a = (from / US) * 100
    const b = (to / US) * 100
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + ((b - a) * x) / w)
      const i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 1)) / w))
      let m = 0
      for (let i = i0; i < i1 && i < peaks.length; i++) m = Math.max(m, peaks[i])
      const bh = Math.max(1, m * h)
      ctx.fillRect(x, h - bh, 1, bh)
    }
  }, [peaks, from, to, width, color])
  return <canvas className="wave" ref={ref} style={{ width: '100%' }} />
}

interface ClipViewProps {
  clip: Clip
  project: Project
  zoom: number
  selected: boolean
  isMain: boolean
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'trim-l' | 'trim-r') => void
}

const ClipView = memo(function ClipView({ clip, project, zoom, selected, onPointerDown }: ClipViewProps) {
  const media = clip.type === 'media' ? project.media[clip.mediaId] : undefined
  const strip = useFilmstrip(media)
  const peaks = useWaveform(media)
  const left = (clip.start / US) * zoom
  const width = Math.max(2, (clip.duration / US) * zoom)
  const kind = clip.type === 'text' ? 'text' : media?.kind === 'audio' ? 'audio' : 'video'
  const style: React.CSSProperties = { left, width }
  if (clip.type === 'media' && strip && media) {
    if (media.kind === 'image') {
      style.backgroundImage = `url("${strip}")`
      style.backgroundSize = 'auto 100%'
    } else {
      const fullW = (media.duration / US / clip.speed) * zoom
      style.backgroundImage = `url("${strip}")`
      style.backgroundSize = `${fullW}px 100%`
      style.backgroundRepeat = 'no-repeat'
      style.backgroundPosition = `${-(clip.sourceIn / US / clip.speed) * zoom}px 0`
    }
  }
  const c = clip as MediaClip
  return (
    <div
      className={`clip ${kind} ${selected ? 'selected' : ''}`}
      style={style}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
    >
      <div className="clip-label">
        <span>{clip.type === 'text' ? clip.text.split('\n')[0] || 'Texto' : media?.name}</span>
        <span className="d">{shortTime(clip.duration)}</span>
      </div>
      {clip.type === 'media' && (
        <div className="fx">
          {c.color.lut && <span>{c.color.lut.name}</span>}
          {c.speed !== 1 && <span>{c.speed}x</span>}
          {c.background.mode === 'chroma' && <span>Chroma</span>}
          {c.volume === 0 && <span>Silencio</span>}
        </div>
      )}
      {peaks && clip.type === 'media' && (
        <Waveform
          peaks={peaks}
          from={clip.sourceIn}
          to={clip.sourceIn + clip.duration * clip.speed}
          width={width}
          color={kind === 'audio' ? '#7fe0a8' : '#ffffff55'}
        />
      )}
      <div className="handle l" onPointerDown={(e) => (e.stopPropagation(), onPointerDown(e, clip, 'trim-l'))} />
      <div className="handle r" onPointerDown={(e) => (e.stopPropagation(), onPointerDown(e, clip, 'trim-r'))} />
    </div>
  )
})

function Playhead({ zoom }: { zoom: number }) {
  const time = useEditor((s) => s.time)
  return <div className="playhead" style={{ left: (time / US) * zoom }} />
}

interface DragState {
  clipId: string
  mode: 'move' | 'trim-l' | 'trim-r'
  startX: number
  grabOffset: number
  moved: boolean
  base: Project
  ghost: { left: number; top: number; width: number; height: number } | null
  snapX: number | null
  target: { trackId: string | null; start: number } | null
}

export function Timeline() {
  const project = useEditor((s) => s.project!)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.zoom)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const [snap, setSnap] = useState(true)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropTrack, setDropTrack] = useState<string | null>(null)
  const [junctionOver, setJunctionOver] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headsRef = useRef<HTMLDivElement>(null)

  const order = useMemo(() => displayOrder(project), [project])
  const duration = projectDuration(project)
  const contentW = Math.max(((duration / US) + 30) * zoom, (scrollRef.current?.clientWidth ?? 1000) + 200)

  const rows = useMemo(() => {
    let y = RULER_H + 6
    return order.map((t) => {
      const h = trackHeight(project, t)
      const row = { track: t, top: y, height: h }
      y += h
      return row
    })
  }, [order, project])
  const contentH = (rows.at(-1)?.top ?? RULER_H) + (rows.at(-1)?.height ?? 0) + 40

  const timeAt = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect()
    return Math.max(0, ((clientX - r.left + scrollRef.current!.scrollLeft) / zoom) * US)
  }
  const rowAt = (clientY: number) => {
    const r = scrollRef.current!.getBoundingClientRect()
    const y = clientY - r.top + scrollRef.current!.scrollTop
    return rows.find((row) => y >= row.top && y < row.top + row.height) ?? null
  }

  // Seguir el cursor durante la reproducción.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (!s.playing || s.time === prev.time || !scrollRef.current) return
        const el = scrollRef.current
        const x = (s.time / US) * s.zoom
        if (x > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = x - 120
      }),
    []
  )

  function snapPoints(exclude: string): number[] {
    const pts = [0, useEditor.getState().time]
    for (const t of project.tracks)
      for (const c of t.clips) if (c.id !== exclude) pts.push(c.start, clipEnd(c))
    return pts
  }

  function snapTime(t: number, exclude: string, extraEdge = 0): { t: number; at: number | null } {
    if (!snap) return { t, at: null }
    const tol = (SNAP_PX / zoom) * US
    let best: { t: number; at: number } | null = null
    for (const p of snapPoints(exclude)) {
      for (const edge of [0, extraEdge]) {
        const d = Math.abs(t + edge - p)
        if (d < tol && (!best || d < Math.abs(best.t + edge - best.at))) best = { t: p - edge, at: p }
      }
    }
    return best ?? { t, at: null }
  }

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: DragState['mode']) => {
    if (e.button !== 0) return
    e.preventDefault()
    const s = useEditor.getState()
    s.select(clip.id)
    const found = findClip(s.project!, clip.id)
    if (found?.track.locked) return
    const state: DragState = {
      clipId: clip.id,
      mode,
      startX: e.clientX,
      grabOffset: timeAt(e.clientX) - clip.start,
      moved: false,
      base: s.project!,
      ghost: null,
      snapX: null,
      target: null
    }
    let current = state

    const move = (ev: PointerEvent) => {
      if (!current.moved && Math.abs(ev.clientX - current.startX) < 3) return
      current = { ...current, moved: true }
      const st = useEditor.getState()
      if (mode === 'move') {
        const raw = timeAt(ev.clientX) - current.grabOffset
        const sn = snapTime(Math.max(0, raw), clip.id, clip.duration)
        const row = rowAt(ev.clientY)
        const kindOk = row && (clip.type === 'text' ? row.track.kind === 'text' : row.track.kind === found!.track.kind)
        const top = kindOk ? row!.top : rowAt(ev.clientY) ? row!.top : (rows.find((r) => r.track === found!.track)?.top ?? 0)
        current = {
          ...current,
          snapX: sn.at !== null ? (sn.at / US) * zoom : null,
          ghost: { left: (sn.t / US) * zoom, top: top + 3, width: (clip.duration / US) * zoom, height: (kindOk ? row!.height : trackHeight(project, found!.track)) - 6 },
          target: { trackId: kindOk ? row!.track.id : null, start: sn.t }
        }
      } else {
        // Recorte en vivo: se rehace desde la base para que todo el gesto sea un solo paso.
        const sn = snapTime(timeAt(ev.clientX), clip.id)
        useEditor.setState({ project: current.base })
        try {
          st.dispatch({ op: 'trimClip', clipId: clip.id, side: mode === 'trim-l' ? 'start' : 'end', time: sn.t })
          useEditor.setState((x) => ({ past: x.past.slice(0, -1) }))
        } catch {
          useEditor.setState({ project: current.base })
        }
        current = { ...current, snapX: sn.at !== null ? (sn.at / US) * zoom : null }
      }
      setDrag(current)
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!current.moved) return
      const st = useEditor.getState()
      if (mode === 'move' && current.target) {
        try {
          st.dispatch({ op: 'moveClip', clipId: clip.id, start: current.target.start, trackId: current.target.trackId ?? undefined })
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), true)
        }
      } else if (mode !== 'move' && st.project !== current.base) {
        useEditor.setState((x) => ({ past: [...x.past, current.base] }))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- Soltar medios desde la biblioteca o desde el explorador ------------------------
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types
    if (types.includes('application/x-cancun-media') || types.includes('application/x-cancun-path') || types.includes('Files')) {
      e.preventDefault()
      setDropTrack(rowAt(e.clientY)?.track.id ?? 'new')
    }
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropTrack(null)
    const start = timeAt(e.clientX)
    const row = rowAt(e.clientY)
    let ids: string[] = []
    const mediaId = e.dataTransfer.getData('application/x-cancun-media')
    const path = e.dataTransfer.getData('application/x-cancun-path')
    const p = useEditor.getState().project!
    if (mediaId) ids = [mediaId]
    else {
      const paths = path ? [path] : [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean)
      ids = (await importFiles(paths)).map((m) => m.id)
    }
    let t = start
    for (const id of ids) {
      const media = useEditor.getState().project!.media[id]
      if (!media) continue
      const wantKind = media.kind === 'audio' ? 'audio' : 'video'
      let trackId = row && row.track.kind === wantKind ? row.track.id : undefined
      if (!trackId && !(wantKind === 'video' && !row)) {
        const [created] = useEditor.getState().dispatch({ op: 'addTrack', kind: wantKind })
        trackId = created
      }
      const clipId = addToTimeline(media, { start: t, trackId: trackId ?? p.tracks[0].id })
      const placed = clipId ? findClip(useEditor.getState().project!, clipId)?.clip : null
      if (placed) t = clipEnd(placed)
    }
  }

  const mainRow = rows.find((r) => r.track === project.tracks[0])!
  const mainClips = project.tracks[0].clips as MediaClip[]

  const zoomTo = (z: number, anchorClientX?: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    const ax = anchorClientX !== undefined ? anchorClientX - r.left : el.clientWidth / 2
    const t = (el.scrollLeft + ax) / zoom
    useEditor.getState().setZoom(z)
    const nz = useEditor.getState().zoom
    requestAnimationFrame(() => (el.scrollLeft = t * nz - ax))
  }

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <button className="icon-btn" title="Deshacer (Ctrl+Z)" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" title="Rehacer (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
          <Icon name="redo" />
        </button>
        <span className="sep" />
        <button className="icon-btn" title="Dividir (Ctrl+B)" onClick={splitAtPlayhead}>
          <Icon name="split" />
        </button>
        <button className="icon-btn" title="Eliminar (Supr)" disabled={!selection} onClick={deleteSelection}>
          <Icon name="trash" />
        </button>
        <span className="spacer" />
        <button className={`icon-btn ${snap ? 'on' : ''}`} title="Imán (ajustar a bordes y cursor)" onClick={() => setSnap(!snap)}>
          <Icon name="magnet" />
        </button>
        <span className="sep" />
        <button className="icon-btn" title="Alejar" onClick={() => zoomTo(zoom / 1.3)}>
          <Icon name="zoomOut" />
        </button>
        <input
          type="range"
          min={Math.log(4)}
          max={Math.log(1200)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))}
        />
        <button className="icon-btn" title="Acercar" onClick={() => zoomTo(zoom * 1.3)}>
          <Icon name="zoomIn" />
        </button>
        <button
          className="icon-btn"
          title="Ajustar a la ventana"
          onClick={() => {
            const w = scrollRef.current!.clientWidth - 80
            useEditor.getState().setZoom(w / Math.max(1, duration / US))
            scrollRef.current!.scrollLeft = 0
          }}
        >
          <Icon name="fit" />
        </button>
      </div>
      <div className="tl-main">
        <div className="tl-heads" ref={headsRef}>
          <div className="tl-heads-inner" style={{ top: -(scrollRef.current?.scrollTop ?? 0) }}>
            {rows.map(({ track, top, height }) => (
              <div key={track.id} className="tl-head" style={{ position: 'absolute', top, height, left: 0, right: 0 }}>
                <button
                  className={`icon-btn ${track.locked ? 'on' : ''}`}
                  title={track.locked ? 'Desbloquear' : 'Bloquear'}
                  onClick={() => useEditor.getState().dispatch({ op: 'updateTrack', trackId: track.id, patch: { locked: !track.locked } })}
                >
                  <Icon name={track.locked ? 'lock' : 'unlock'} size={14} />
                </button>
                {track.kind !== 'audio' && (
                  <button
                    className="icon-btn"
                    title={track.hidden ? 'Mostrar' : 'Ocultar'}
                    onClick={() => useEditor.getState().dispatch({ op: 'updateTrack', trackId: track.id, patch: { hidden: !track.hidden } })}
                  >
                    <Icon name={track.hidden ? 'eyeOff' : 'eye'} size={14} />
                  </button>
                )}
                {track.kind !== 'text' && (
                  <button
                    className="icon-btn"
                    title={track.muted ? 'Activar sonido' : 'Silenciar'}
                    onClick={() => useEditor.getState().dispatch({ op: 'updateTrack', trackId: track.id, patch: { muted: !track.muted } })}
                  >
                    <Icon name={track.muted ? 'mute' : 'volume'} size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            setScrollLeft(e.currentTarget.scrollLeft)
            const inner = headsRef.current?.firstElementChild as HTMLElement | null
            if (inner) inner.style.top = `${-e.currentTarget.scrollTop}px`
          }}
          onWheel={(e) => {
            if (e.ctrlKey) {
              e.preventDefault()
              zoomTo(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX)
            } else if (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) && !e.altKey) {
              // Rueda normal = desplazamiento horizontal, como en los editores de video.
              scrollRef.current!.scrollLeft += e.deltaY
            }
          }}
          onDragOver={onDragOver}
          onDragLeave={() => setDropTrack(null)}
          onDrop={onDrop}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('track') || (e.target as HTMLElement).classList.contains('tl-content')) {
              useEditor.getState().select(null)
              useEditor.getState().seek(timeAt(e.clientX))
            }
          }}
        >
          <div className="tl-content" style={{ width: contentW, height: contentH }}>
            <Ruler
              zoom={zoom}
              width={contentW}
              scrollLeft={scrollLeft}
              onSeek={(x) => {
                const seekTo = (cx: number) => useEditor.getState().seek(timeAt(cx))
                seekTo(x)
                const move = (ev: PointerEvent) => seekTo(ev.clientX)
                const up = () => {
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', up)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up)
              }}
            />
            {rows.map(({ track, top, height }) => (
              <div
                key={track.id}
                className={`track ${track === project.tracks[0] ? 'main' : ''} ${dropTrack === track.id ? 'drop-target' : ''}`}
                style={{ position: 'absolute', top, height, left: 0, width: contentW, opacity: track.hidden ? 0.45 : 1 }}
              >
                {track.clips.map((c) => (
                  <ClipView
                    key={c.id}
                    clip={c}
                    project={project}
                    zoom={zoom}
                    selected={selection === c.id}
                    isMain={track === project.tracks[0]}
                    onPointerDown={onClipPointerDown}
                  />
                ))}
              </div>
            ))}
            {/* Uniones de la pista principal: destino de transiciones y marca de las existentes. */}
            {mainClips.slice(0, -1).map((c, i) => {
              const x = (clipEnd(c) / US) * zoom
              const top = mainRow.top
              return (
                <div key={c.id + mainClips[i + 1].id}>
                  <div
                    className={`junction-target ${junctionOver === c.id ? 'over' : ''}`}
                    style={{ left: x, top: top + 4, height: mainRow.height - 8, position: 'absolute' }}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/x-cancun-transition')) {
                        e.preventDefault()
                        e.stopPropagation()
                        setJunctionOver(c.id)
                      }
                    }}
                    onDragLeave={() => setJunctionOver(null)}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setJunctionOver(null)
                      const kind = e.dataTransfer.getData('application/x-cancun-transition') as TransitionKind
                      if (kind) applyTransition(c.id, { kind, duration: c.transition?.duration ?? DEFAULT_TRANSITION_US })
                    }}
                  />
                  {c.transition && (
                    <div
                      className="transition-mark"
                      style={{ left: x, top: top + mainRow.height / 2 }}
                      title={`${TRANSITIONS.find((t) => t.kind === c.transition!.kind)?.label} · ${(c.transition.duration / US).toFixed(1)}s — doble clic para quitar`}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        useEditor.getState().select(c.id)
                      }}
                      onDoubleClick={() => applyTransition(c.id, null)}
                    >
                      <Icon name="transitions" size={11} />
                    </div>
                  )}
                </div>
              )
            })}
            {drag?.ghost && <div className="ghost-clip" style={drag.ghost} />}
            {drag?.snapX !== null && drag?.snapX !== undefined && <div className="snap-line" style={{ left: drag.snapX }} />}
            <Playhead zoom={zoom} />
          </div>
        </div>
      </div>
    </div>
  )
}
