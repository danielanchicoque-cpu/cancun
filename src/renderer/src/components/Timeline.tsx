import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Op } from '@shared/ops'
import { type Clip, type MediaClip, type Project, type TextStyle, type Track, type TransitionKind, US, clipEnd, findClip, projectDuration } from '@shared/project'
import { interpolate } from '@shared/animate'
import { useEditor } from '../store'
import { useStrip, useWaveform, type Strip } from '../assets'
import {
  DEFAULT_TRANSITION_US,
  addToTimeline,
  applyTransition,
  deleteSelection,
  duplicateSelection,
  freezeAtPlayhead,
  importFiles,
  mirrorSelection,
  reverseSelection,
  rotateSelection,
  separateAudio,
  splitAtPlayhead,
  toast,
  trimToPlayhead
} from '../actions'
import { api } from '../api'
import { dbToGain, gainToDb, shortTime } from '../format'
import { TRANSITIONS } from './catalog'
import { EFFECTS } from '../gl/shaders'
import { Icon, type IconName } from './icons'

const RULER_H = 26
const NEW_TRACK_ZONE = 26
const SNAP_PX = 8
const HEIGHT: Record<Track['kind'] | 'main', number> = { main: 72, video: 58, audio: 48, text: 30, effect: 30 }

const trackHeight = (p: Project, t: Track) => (p.tracks[0] === t ? HEIGHT.main : HEIGHT[t.kind])

/** Orden visual como CapCut: capas, textos y efectos encima de la principal; audio debajo. */
function displayOrder(p: Project): Track[] {
  const above = p.tracks.slice(1).filter((t) => t.kind !== 'audio').reverse()
  const audio = p.tracks.slice(1).filter((t) => t.kind === 'audio')
  return [...above, p.tracks[0], ...audio]
}

function clipKindOf(p: Project, c: Clip): Track['kind'] {
  if (c.type === 'text') return 'text'
  if (c.type === 'effect') return 'effect'
  return p.media[c.mediaId]?.kind === 'audio' ? 'audio' : 'video'
}

// --- Regla -----------------------------------------------------------------------------

function Ruler({ zoom, width, scrollLeft, fps, onSeek }: { zoom: number; width: number; scrollLeft: number; fps: number; onSeek: (e: React.PointerEvent) => void }) {
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
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    const major = steps.find((s) => s * zoom >= 80) ?? 600
    const minor = major / 5
    ctx.strokeStyle = '#4a4a50'
    ctx.fillStyle = '#8a8a90'
    ctx.font = '10px Segoe UI'
    const first = Math.floor(scrollLeft / zoom / minor)
    for (let i = first; i * minor * zoom - scrollLeft < viewW; i++) {
      const s = Math.round(i * minor * 1e6) / 1e6
      const x = Math.round(s * zoom - scrollLeft) + 0.5
      const isMajor = i % 5 === 0
      ctx.beginPath()
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, RULER_H - (isMajor ? 10 : 5))
      ctx.stroke()
      if (isMajor) {
        const f = Math.round((s % 1) * fps)
        ctx.fillText(major < 1 && f ? `${f}f` : shortTime(s * US), x + 3, 11)
      }
    }
  }, [zoom, width, scrollLeft, fps])
  return (
    <div className="ruler" style={{ width }} onPointerDown={onSeek}>
      <canvas ref={ref} style={{ position: 'sticky', left: 0 }} />
    </div>
  )
}

// --- Dibujo de clips ---------------------------------------------------------------------

/** Cuadros en su proporción real, uno junto a otro, tomados del tiempo que muestran. */
function Filmstrip({ strip, clip, zoom, width, height, mediaDur, aspect }: { strip: Strip; clip: MediaClip; zoom: number; width: number; height: number; mediaDur: number; aspect: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const cv = ref.current!
    const w = Math.max(1, Math.min(16000, Math.round(width)))
    cv.width = w
    cv.height = height
    const ctx = cv.getContext('2d')!
    const tileW = Math.max(8, Math.round(height * aspect))
    const fw = strip.image.naturalWidth / strip.frames
    const fh = strip.image.naturalHeight
    for (let x = 0; x < w; x += tileW) {
      const t = clip.freeze ? clip.sourceIn : clip.sourceIn + ((x + tileW / 2) / zoom) * US * clip.speed
      const i = Math.max(0, Math.min(strip.frames - 1, Math.floor((t / Math.max(1, mediaDur)) * strip.frames)))
      ctx.drawImage(strip.image, i * fw, 0, fw, fh, x, 0, tileW, height)
    }
  }, [strip, clip.sourceIn, clip.speed, clip.freeze, zoom, width, height, mediaDur, aspect])
  return <canvas ref={ref} className="strip" />
}

function Waveform({ peaks, from, to, width, color }: { peaks: number[]; from: number; to: number; width: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const cv = ref.current!
    const w = Math.max(1, Math.min(16000, Math.round(width)))
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
  return <canvas className="wave" ref={ref} />
}

/** Posición vertical de la línea de volumen: 0 dB a un tercio, +20 dB arriba, −60 dB abajo. */
const volumeY = (gain: number) => {
  const db = gainToDb(gain)
  return db >= 0 ? (1 - db / 20) * 0.33 : 0.33 + (Math.min(60, -db) / 60) * 0.67
}
const yToGain = (y: number) => (y <= 0.33 ? dbToGain((1 - y / 0.33) * 20) : dbToGain(-((y - 0.33) / 0.67) * 60))

type DragMode = 'move' | 'trim-l' | 'trim-r' | 'volume'

interface ClipViewProps {
  clip: Clip
  project: Project
  zoom: number
  height: number
  selected: boolean
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: DragMode) => void
  onContext: (e: React.MouseEvent, clip: Clip) => void
}

const ClipView = memo(function ClipView({ clip, project, zoom, height, selected, onPointerDown, onContext }: ClipViewProps) {
  const media = clip.type === 'media' ? project.media[clip.mediaId] : undefined
  const strip = useStrip(media)
  const peaks = useWaveform(media)
  const left = (clip.start / US) * zoom
  const width = Math.max(2, (clip.duration / US) * zoom)
  const kind = clipKindOf(project, clip)
  const c = clip as MediaClip
  const isAudio = kind === 'audio'
  const hasVolume = clip.type === 'media' && media?.hasAudio && media.kind !== 'image'
  const volKeys = clip.type === 'media' ? clip.keyframes.volume : undefined
  const keyTimes = useMemo(() => {
    const set = new Set<number>()
    for (const kfs of Object.values(clip.keyframes)) for (const k of kfs ?? []) set.add(k.t)
    return [...set]
  }, [clip.keyframes])
  const label =
    clip.type === 'text' ? clip.text.split('\n')[0] || 'Texto' : clip.type === 'effect' ? EFFECTS.find((e) => e.id === clip.effect)?.label ?? clip.effect : (c.freeze ? '❄ ' : '') + (media?.name ?? '')
  const innerH = height - 6
  // En video la línea de volumen vive sobre la forma de onda (abajo); en audio ocupa todo el alto.
  const volH = isAudio ? innerH : Math.round(innerH * 0.45)
  return (
    <div
      className={`clip ${kind} ${selected ? 'selected' : ''}`}
      style={{ left, width }}
      data-clip-id={clip.id}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      onContextMenu={(e) => onContext(e, clip)}
    >
      {strip && clip.type === 'media' && media && !isAudio && (
        <Filmstrip strip={strip} clip={clip} zoom={zoom} width={width} height={innerH} mediaDur={media.duration} aspect={(media.width ?? 16) / (media.height ?? 9)} />
      )}
      <div className="clip-label">
        <span>{label}</span>
        <span className="d">{shortTime(clip.duration)}</span>
      </div>
      {clip.type === 'media' && (
        <div className="fx">
          {c.color.lut && <span>{c.color.lut.name}</span>}
          {c.speed !== 1 && <span>{c.speed}x</span>}
          {c.background.mode !== 'none' && <span>{c.background.mode === 'chroma' ? 'Chroma' : 'Sin fondo'}</span>}
          {c.mask.shape !== 'none' && <span>Máscara</span>}
          {c.blend !== 'normal' && <span>Mezcla</span>}
          {(c.animations.in || c.animations.out || c.animations.combo) && <span>Anim</span>}
        </div>
      )}
      {peaks && clip.type === 'media' && !c.freeze && (
        <Waveform peaks={peaks} from={clip.sourceIn} to={clip.sourceIn + clip.duration * clip.speed} width={width} color={isAudio ? '#7fe0a8' : '#ffffff55'} />
      )}
      {hasVolume && (
        <svg className="volume-line" width={width} height={volH} style={{ top: innerH - volH }}>
          {volKeys?.length ? (
            <polyline
              fill="none"
              points={Array.from({ length: 48 }, (_, i) => {
                const t = (clip.duration * i) / 47
                return `${(t / US) * zoom},${volumeY(interpolate(volKeys, t)) * volH}`
              }).join(' ')}
            />
          ) : (
            <line x1={0} x2={width} y1={volumeY(c.volume) * volH} y2={volumeY(c.volume) * volH} />
          )}
          {!volKeys?.length && (
            <rect
              className="volume-hit"
              x={0}
              width={width}
              y={volumeY(c.volume) * volH - 4}
              height={8}
              onPointerDown={(e) => {
                e.stopPropagation()
                onPointerDown(e, clip, 'volume')
              }}
            >
              <title>{`Volumen ${gainToDb(c.volume).toFixed(1)} dB — arrastra para cambiarlo`}</title>
            </rect>
          )}
        </svg>
      )}
      {keyTimes.map((t) => (
        <span key={t} className="kf-mark" style={{ left: (t / US) * zoom }} />
      ))}
      <div className="handle l" onPointerDown={(e) => (e.stopPropagation(), onPointerDown(e, clip, 'trim-l'))} />
      <div className="handle r" onPointerDown={(e) => (e.stopPropagation(), onPointerDown(e, clip, 'trim-r'))} />
    </div>
  )
})

function Playhead({ zoom, onDrag }: { zoom: number; onDrag: (e: React.PointerEvent) => void }) {
  const time = useEditor((s) => s.time)
  return (
    <div className="playhead" style={{ left: (time / US) * zoom }}>
      <div className="playhead-grip" onPointerDown={onDrag} />
    </div>
  )
}

interface Row {
  track: Track
  top: number
  height: number
}

interface Ghost {
  left: number
  top: number
  width: number
  height: number
}

interface Menu {
  x: number
  y: number
  clip: Clip
}

const TOOLS: { icon: IconName; title: string; run: () => void; needsSelection?: boolean }[] = [
  { icon: 'split', title: 'Dividir (Ctrl+B)', run: splitAtPlayhead },
  { icon: 'trimLeft', title: 'Eliminar a la izquierda (Q)', run: () => trimToPlayhead('left') },
  { icon: 'trimRight', title: 'Eliminar a la derecha (W)', run: () => trimToPlayhead('right') },
  { icon: 'trash', title: 'Eliminar (Supr)', run: deleteSelection, needsSelection: true },
  { icon: 'duplicate', title: 'Duplicar (Ctrl+D)', run: duplicateSelection, needsSelection: true },
  { icon: 'freeze', title: 'Congelar cuadro', run: freezeAtPlayhead },
  { icon: 'reverse', title: 'Invertir', run: () => void reverseSelection() },
  { icon: 'mirror', title: 'Espejo', run: mirrorSelection },
  { icon: 'rotate', title: 'Girar 90°', run: rotateSelection },
  { icon: 'detachAudio', title: 'Separar audio', run: separateAudio }
]

const DROP_TYPES = [
  'application/x-cancun-media',
  'application/x-cancun-path',
  'application/x-cancun-text',
  'application/x-cancun-lut',
  'application/x-cancun-effect',
  'application/x-cancun-transition',
  'Files'
]

export function Timeline() {
  const project = useEditor((s) => s.project!)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.zoom)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [snapX, setSnapX] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [dropRow, setDropRow] = useState<string | null>(null)
  const [junctionOver, setJunctionOver] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headsRef = useRef<HTMLDivElement>(null)
  const settings = project.settings
  const selected = useMemo(() => new Set(selection), [selection])

  const order = useMemo(() => displayOrder(project), [project])
  const duration = projectDuration(project)
  const contentW = Math.max((duration / US + 30) * zoom, (scrollRef.current?.clientWidth ?? 1000) + 200)

  const rows: Row[] = useMemo(() => {
    let y = RULER_H + NEW_TRACK_ZONE
    return order.map((t) => {
      const h = trackHeight(project, t)
      const row = { track: t, top: y, height: h }
      y += h
      return row
    })
  }, [order, project])
  const rowsBottom = (rows.at(-1)?.top ?? RULER_H) + (rows.at(-1)?.height ?? 0)
  const contentH = rowsBottom + NEW_TRACK_ZONE + 30
  const mainRow = rows.find((r) => r.track === project.tracks[0])!

  const local = (clientX: number, clientY: number) => {
    const r = scrollRef.current!.getBoundingClientRect()
    return { x: clientX - r.left + scrollRef.current!.scrollLeft, y: clientY - r.top + scrollRef.current!.scrollTop }
  }
  const timeAt = (clientX: number) => Math.max(0, (local(clientX, 0).x / zoom) * US)
  const rowAtY = (y: number) => rows.find((row) => y >= row.top && y < row.top + row.height) ?? null

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

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  function snapTime(t: number, exclude: Set<string>, length = 0): { t: number; at: number | null } {
    if (!settings.snap) return { t, at: null }
    const tol = (SNAP_PX / zoom) * US
    const pts = [0, useEditor.getState().time]
    for (const tr of project.tracks) for (const c of tr.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c))
    let best: { t: number; at: number; d: number } | null = null
    for (const p of pts) {
      for (const edge of [0, length]) {
        const d = Math.abs(t + edge - p)
        if (d < tol && (!best || d < best.d)) best = { t: p - edge, at: p, d }
      }
    }
    return best ? { t: best.t, at: best.at } : { t, at: null }
  }

  // --- Arrastres sobre clips -------------------------------------------------------------
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setMenu(null)
    const s = useEditor.getState()
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      s.select(clip.id, 'toggle')
      return
    }
    if (!s.selection.includes(clip.id)) s.select(clip.id)
    const found = findClip(s.project!, clip.id)
    if (!found || found.track.locked) return
    const base = s.project!
    const sel = useEditor.getState().selection
    const group = sel.length > 1 && mode === 'move' ? sel : [clip.id]
    const exclude = new Set(group)
    const startX = e.clientX
    const startY = e.clientY
    const grab = timeAt(e.clientX) - clip.start
    const groupStart = Math.min(...group.map((id) => findClip(base, id)?.clip.start ?? clip.start))
    const clipEl = (e.target as Element).closest('.clip') as HTMLElement | null
    let moved = false
    let target: { start: number; trackId: string | 'new' | undefined } | null = null

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return
      moved = true
      const st = useEditor.getState()
      if (mode === 'volume' && clip.type === 'media' && clipEl) {
        const r = (clipEl.querySelector('.volume-line') as SVGElement).getBoundingClientRect()
        const y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))
        st.preview(base, { op: 'updateClip', clipId: clip.id, patch: { volume: Math.round(yToGain(y) * 1000) / 1000 } })
        return
      }
      if (mode === 'trim-l' || mode === 'trim-r') {
        const sn = snapTime(timeAt(ev.clientX), exclude)
        try {
          st.preview(base, { op: 'trimClip', clipId: clip.id, side: mode === 'trim-l' ? 'start' : 'end', time: sn.t })
        } catch {
          /* el recorte no cabe: se ignora este paso */
        }
        setSnapX(sn.at !== null ? (sn.at / US) * zoom : null)
        return
      }
      const raw = Math.max(0, timeAt(ev.clientX) - grab)
      if (group.length > 1) {
        const sn = snapTime(groupStart + (raw - clip.start), exclude)
        st.preview(base, { op: 'moveClips', clipIds: group, delta: sn.t - groupStart })
        setSnapX(sn.at !== null ? (sn.at / US) * zoom : null)
        return
      }
      const sn = snapTime(raw, exclude, clip.duration)
      const { y } = local(ev.clientX, ev.clientY)
      const kind = clipKindOf(base, clip)
      const row = rowAtY(y)
      let trackId: string | 'new' | undefined
      let top: number
      let h: number
      if (row && row.track.kind === kind) {
        trackId = row.track.id
        top = row.top
        h = row.height
      } else if (y < rows[0].top || (y >= rowsBottom && kind === 'audio')) {
        // Soltar por encima (o por debajo, para audio) crea una pista nueva.
        trackId = 'new'
        top = y < rows[0].top ? RULER_H + 2 : rowsBottom + 2
        h = NEW_TRACK_ZONE - 4
      } else {
        trackId = found.track.id
        const r = rows.find((x) => x.track === found.track)!
        top = r.top
        h = r.height
      }
      target = { start: sn.t, trackId }
      setGhost({ left: (sn.t / US) * zoom, top: top + 3, width: (clip.duration / US) * zoom, height: h - 6 })
      setSnapX(sn.at !== null ? (sn.at / US) * zoom : null)
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGhost(null)
      setSnapX(null)
      if (!moved) {
        if (mode === 'move') useEditor.getState().select(clip.id)
        return
      }
      if (mode === 'move' && group.length === 1 && target) {
        try {
          useEditor.getState().dispatch({ op: 'moveClip', clipId: clip.id, start: target.start, trackId: target.trackId })
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), true)
        }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- Selección por rectángulo y clic en vacío --------------------------------------------
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.clip, .transition-mark, .ruler, .playhead-grip')) return
    const start = local(e.clientX, e.clientY)
    const additive = e.ctrlKey || e.shiftKey
    const before = additive ? useEditor.getState().selection : []
    let moved = false
    const move = (ev: PointerEvent) => {
      const cur = local(ev.clientX, ev.clientY)
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 4) return
      moved = true
      const box = { x0: Math.min(start.x, cur.x), y0: Math.min(start.y, cur.y), x1: Math.max(start.x, cur.x), y1: Math.max(start.y, cur.y) }
      setMarquee(box)
      const hit: string[] = []
      for (const row of rows) {
        if (row.top + row.height < box.y0 || row.top > box.y1) continue
        for (const c of row.track.clips) {
          const x0 = (c.start / US) * zoom
          const x1 = (clipEnd(c) / US) * zoom
          if (x1 >= box.x0 && x0 <= box.x1) hit.push(c.id)
        }
      }
      useEditor.getState().select([...new Set([...before, ...hit])])
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!moved) {
        if (!additive) useEditor.getState().select(null)
        useEditor.getState().seek(timeAt(e.clientX))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragPlayhead = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const seekTo = (cx: number) => useEditor.getState().seek(timeAt(cx))
    seekTo(e.clientX)
    const move = (ev: PointerEvent) => seekTo(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- Soltar cosas desde los paneles ------------------------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.some((t) => DROP_TYPES.includes(t))) return
    e.preventDefault()
    const { y } = local(e.clientX, e.clientY)
    setDropRow(rowAtY(y)?.track.id ?? (y < (rows[0]?.top ?? 0) ? 'new-top' : 'new-bottom'))
  }

  const clipAtPoint = (x: number, y: number): Clip | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-clip-id]') as HTMLElement | null
    return el ? findClip(useEditor.getState().project!, el.dataset.clipId!)?.clip ?? null : null
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropRow(null)
    const dt = e.dataTransfer
    const at = timeAt(e.clientX)
    const { y } = local(e.clientX, e.clientY)
    const row = rowAtY(y)
    const st = useEditor.getState()
    const run = (ops: Op | Op[]) => {
      try {
        return st.dispatch(ops)
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), true)
        return []
      }
    }

    const lut = dt.getData('application/x-cancun-lut')
    if (lut) {
      const target = clipAtPoint(e.clientX, e.clientY)
      if (!target || target.type !== 'media') return toast('Suelta el LUT encima de un clip de video', true)
      const l = JSON.parse(lut) as { path: string; name: string }
      run({ op: 'setLut', clipId: target.id, lut: { ...l, intensity: target.color.lut?.intensity ?? 1 } })
      st.select(target.id)
      return
    }
    const transition = dt.getData('application/x-cancun-transition') as TransitionKind
    if (transition) {
      const target = clipAtPoint(e.clientX, e.clientY)
      if (target?.type === 'media') applyTransition(target.id, { kind: transition, duration: target.transition?.duration ?? DEFAULT_TRANSITION_US })
      else toast('Suelta la transición entre dos clips de la pista principal', true)
      return
    }
    const effect = dt.getData('application/x-cancun-effect')
    if (effect) {
      const [id] = run({ op: 'addEffect', effect, start: at })
      if (id) st.select(id)
      return
    }
    const text = dt.getData('application/x-cancun-text')
    if (text) {
      const preset = JSON.parse(text) as { text: string; style: Partial<TextStyle> }
      const [id] = run({ op: 'addText', text: preset.text, start: at, style: preset.style, trackId: row?.track.kind === 'text' ? row.track.id : undefined })
      if (id) st.select(id)
      return
    }

    let ids: string[] = []
    const mediaId = dt.getData('application/x-cancun-media')
    const path = dt.getData('application/x-cancun-path')
    if (mediaId) ids = [mediaId]
    else {
      const paths = path ? [path] : [...dt.files].map((f) => api.pathOf(f)).filter(Boolean)
      ids = (await importFiles(paths)).map((m) => m.id)
    }
    let t = at
    for (const id of ids) {
      const media = useEditor.getState().project!.media[id]
      if (!media) continue
      const kind = media.kind === 'audio' ? 'audio' : 'video'
      let trackId: string | undefined
      if (row && row.track.kind === kind) trackId = row.track.id
      else if (kind === 'audio' || y < rows[0].top || row) trackId = 'new'
      const clipId = addToTimeline(media, { start: t, trackId })
      const placed = clipId ? findClip(useEditor.getState().project!, clipId)?.clip : null
      if (placed) t = clipEnd(placed)
    }
  }

  const zoomTo = (z: number, anchorClientX?: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    const ax = anchorClientX !== undefined ? anchorClientX - r.left : el.clientWidth / 2
    const t = (el.scrollLeft + ax) / zoom
    useEditor.getState().setZoom(z)
    const nz = useEditor.getState().zoom
    requestAnimationFrame(() => (el.scrollLeft = t * nz - ax))
  }

  const setSetting = (patch: Partial<typeof settings>) => useEditor.getState().dispatch({ op: 'setSettings', patch })
  const mainClips = project.tracks[0].clips as MediaClip[]

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
        {TOOLS.map((t) => (
          <button key={t.icon} className="icon-btn" title={t.title} disabled={t.needsSelection && !selection.length} onClick={t.run}>
            <Icon name={t.icon} />
          </button>
        ))}
        <span className="spacer" />
        <button
          className={`toggle-btn ${settings.mainMagnet ? 'on' : ''}`}
          title={settings.mainMagnet ? 'Desactivar el imán de la pista principal' : 'Activar el imán de la pista principal'}
          onClick={() => setSetting({ mainMagnet: !settings.mainMagnet })}
        >
          <Icon name="magnet" />
        </button>
        <button
          className={`toggle-btn ${settings.snap ? 'on' : ''}`}
          title={settings.snap ? 'Desactivar el ajuste automático' : 'Activar el ajuste automático'}
          onClick={() => setSetting({ snap: !settings.snap })}
        >
          <Icon name="snap" />
        </button>
        <button
          className={`toggle-btn ${settings.linkage ? 'on' : ''}`}
          title={settings.linkage ? 'Desactivar la vinculación' : 'Activar la vinculación'}
          onClick={() => setSetting({ linkage: !settings.linkage })}
        >
          <Icon name={settings.linkage ? 'link' : 'unlink'} />
        </button>
        <span className="sep" />
        <button className="icon-btn" title="Alejar" onClick={() => zoomTo(zoom / 1.3)}>
          <Icon name="zoomOut" />
        </button>
        <input type="range" min={Math.log(4)} max={Math.log(1200)} step={0.01} value={Math.log(zoom)} onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))} />
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
          <div className="tl-heads-inner">
            {rows.map(({ track, top, height }) => (
              <div key={track.id} className="tl-head" style={{ top, height }}>
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
                {(track.kind === 'video' || track.kind === 'audio') && (
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
            if (inner) inner.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`
          }}
          onWheel={(e) => {
            if (e.ctrlKey) {
              e.preventDefault()
              zoomTo(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX)
            } else if (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) && !e.altKey) {
              scrollRef.current!.scrollLeft += e.deltaY
            }
          }}
          onDragOver={onDragOver}
          onDragLeave={() => setDropRow(null)}
          onDrop={onDrop}
          onPointerDown={onBackgroundPointerDown}
        >
          <div className="tl-content" style={{ width: contentW, height: contentH }}>
            <Ruler zoom={zoom} width={contentW} scrollLeft={scrollLeft} fps={project.canvas.fps} onSeek={dragPlayhead} />
            <div className={`new-track-zone ${dropRow === 'new-top' ? 'drop-target' : ''}`} style={{ top: RULER_H, width: contentW }} />
            {rows.map(({ track, top, height }) => (
              <div
                key={track.id}
                className={`track ${track === project.tracks[0] ? 'main' : ''} ${dropRow === track.id ? 'drop-target' : ''} ${track.locked ? 'locked' : ''}`}
                style={{ top, height, width: contentW, opacity: track.hidden ? 0.45 : 1 }}
              >
                {track.clips.map((c) => (
                  <ClipView
                    key={c.id}
                    clip={c}
                    project={project}
                    zoom={zoom}
                    height={height}
                    selected={selected.has(c.id)}
                    onPointerDown={onClipPointerDown}
                    onContext={(e, clip) => {
                      e.preventDefault()
                      if (!useEditor.getState().selection.includes(clip.id)) useEditor.getState().select(clip.id)
                      setMenu({ x: e.clientX, y: e.clientY, clip })
                    }}
                  />
                ))}
              </div>
            ))}
            <div className={`new-track-zone ${dropRow === 'new-bottom' ? 'drop-target' : ''}`} style={{ top: rowsBottom, width: contentW }} />
            {/* Uniones de la pista principal: destino de transiciones y marca de las existentes. */}
            {mainClips.slice(0, -1).map((c, i) => {
              if (mainClips[i + 1].start !== clipEnd(c)) return null
              const x = (clipEnd(c) / US) * zoom
              return (
                <div key={c.id + mainClips[i + 1].id}>
                  <div
                    className={`junction-target ${junctionOver === c.id ? 'over' : ''}`}
                    style={{ left: x, top: mainRow.top + 4, height: mainRow.height - 8 }}
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
                      style={{ left: x, top: mainRow.top + mainRow.height / 2 }}
                      title={`${TRANSITIONS.find((t) => t.kind === c.transition!.kind)?.label ?? c.transition.kind} · ${(c.transition.duration / US).toFixed(1)}s — doble clic para quitar`}
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
            {ghost && <div className="ghost-clip" style={ghost} />}
            {snapX !== null && <div className="snap-line" style={{ left: snapX }} />}
            {marquee && <div className="marquee" style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} />}
            <Playhead zoom={zoom} onDrag={dragPlayhead} />
          </div>
        </div>
      </div>
      {menu && (
        <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 280) }} onPointerDown={(e) => e.stopPropagation()}>
          {[
            { label: 'Dividir', key: 'Ctrl+B', run: splitAtPlayhead },
            { label: 'Duplicar', key: 'Ctrl+D', run: duplicateSelection },
            { label: 'Copiar', key: 'Ctrl+C', run: () => useEditor.getState().copy() },
            { label: 'Congelar cuadro', key: '', run: freezeAtPlayhead, media: true },
            { label: 'Separar audio', key: '', run: separateAudio, media: true },
            { label: 'Invertir', key: '', run: () => void reverseSelection(), media: true },
            { label: 'Espejo', key: '', run: mirrorSelection },
            { label: 'Eliminar', key: 'Supr', run: deleteSelection }
          ]
            .filter((i) => !i.media || menu.clip.type === 'media')
            .map((i) => (
              <button
                key={i.label}
                onClick={() => {
                  i.run()
                  setMenu(null)
                }}
              >
                <span>{i.label}</span>
                <kbd>{i.key}</kbd>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
