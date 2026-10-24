import { useEffect, useRef, useState } from 'react'
import type { ClipPatch, Op } from '@shared/ops'
import { ANIMATIONS, COMBOS, DEFAULT_ANIMATION_US, getPath, resolveClip } from '@shared/animate'
import {
  type Adjust,
  type AdjustClip,
  type Clip,
  type EffectClip,
  type KeyProp,
  type MediaClip,
  type Project,
  type TextClip,
  type TransitionKind,
  US,
  defaultAdjust,
  defaultCrop,
  defaultLight,
  defaultMask,
  defaultRetouch,
  defaultTransform,
  findClip
} from '@shared/project'
import { primarySelection, useEditor } from '../store'
import { api, type LutEntry } from '../api'
import { applyTransition } from '../actions'
import { dbToGain, gainToDb } from '../format'
import { EFFECTS } from '../gl/shaders'
import { BLENDS, MASKS, TRANSITIONS } from './catalog'
import { Icon } from './icons'

const KEY_EPS = US / 120

// --- Propiedades con keyframes -------------------------------------------------------

/** Construye el parche anidado para una ruta tipo "color.adjust.brightness". */
function patchFor(prop: string, v: number | boolean | string | null): ClipPatch {
  const keys = prop.split('.')
  const out: Record<string, unknown> = {}
  let cur = out
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = v
    else cur = cur[k] = {} as Record<string, unknown>
  })
  return out as ClipPatch
}

interface Live {
  begin(): void
  set(op: Op | Op[]): void
  end(): void
}

/** Los cambios de un gesto (arrastrar un deslizador) cuentan como un solo paso de deshacer. */
function useLive(): Live {
  const base = useRef<Project | null>(null)
  return {
    begin() {
      base.current = useEditor.getState().project
    },
    set(op) {
      const s = useEditor.getState()
      try {
        if (base.current) s.preview(base.current, op)
        else s.dispatch(op)
      } catch {
        /* valores fuera de rango durante el arrastre: se ignoran */
      }
    },
    end() {
      base.current = null
    }
  }
}

function useNow(): number {
  return useEditor((s) => (s.playing ? -1 : s.time))
}

interface PropCtl {
  value: number
  hasKeys: boolean
  keyHere: boolean
  set(v: number): void
  toggleKey(): void
  prevKey(): void
  nextKey(): void
  live: Live
}

function useProp(clip: Clip, prop: KeyProp, fallback = 0): PropCtl {
  const now = useNow()
  const time = now < 0 ? useEditor.getState().time : now
  const live = useLive()
  const kfs = clip.keyframes[prop] ?? []
  const hasKeys = kfs.length > 0
  const local = time - clip.start
  const inside = local >= 0 && local <= clip.duration
  const value = getPath(hasKeys && inside ? resolveClip(clip, time) : clip, prop) ?? fallback
  const keyHere = kfs.some((k) => Math.abs(k.t - local) <= KEY_EPS)
  const at = Math.min(clip.start + clip.duration, Math.max(clip.start, time))
  return {
    value,
    hasKeys,
    keyHere,
    live,
    set(v) {
      live.set(hasKeys ? { op: 'setKeyframe', clipId: clip.id, prop, time: at, value: v } : { op: 'updateClip', clipId: clip.id, patch: patchFor(prop, v) })
    },
    toggleKey() {
      const s = useEditor.getState()
      if (keyHere) s.dispatch({ op: 'removeKeyframe', clipId: clip.id, prop, time: at })
      else s.dispatch({ op: 'setKeyframe', clipId: clip.id, prop, time: at, value })
    },
    prevKey() {
      const prev = [...kfs].reverse().find((k) => k.t < local - KEY_EPS)
      if (prev) useEditor.getState().seek(clip.start + prev.t)
    },
    nextKey() {
      const next = kfs.find((k) => k.t > local + KEY_EPS)
      if (next) useEditor.getState().seek(clip.start + next.t)
    }
  }
}

function KeyButtons({ ctl }: { ctl: PropCtl }) {
  return (
    <span className="kf-buttons">
      {ctl.hasKeys && (
        <button className="icon-btn tiny" title="Keyframe anterior" onClick={ctl.prevKey}>
          <Icon name="chevronLeft" size={11} />
        </button>
      )}
      <button className={`icon-btn tiny kf-btn ${ctl.keyHere ? 'on' : ctl.hasKeys ? 'has' : ''}`} title={ctl.keyHere ? 'Quitar keyframe' : 'Agregar keyframe aquí'} onClick={ctl.toggleKey}>
        <Icon name="diamond" size={11} />
      </button>
      {ctl.hasKeys && (
        <button className="icon-btn tiny" title="Keyframe siguiente" onClick={ctl.nextKey}>
          <Icon name="chevronRight" size={11} />
        </button>
      )}
    </span>
  )
}

// --- Controles básicos -------------------------------------------------------------------

function NumberInput({ value, onCommit, suffix, width = 74 }: { value: number; onCommit: (v: number) => void; suffix?: string; width?: number }) {
  const [text, setText] = useState<string | null>(null)
  const shown = Math.round(value * 100) / 100
  return (
    <input
      className="num"
      style={{ width }}
      value={text ?? `${shown}${suffix ?? ''}`}
      onFocus={(e) => {
        setText(String(shown))
        e.target.select()
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text?.replace(',', '.'))
        if (text !== null && Number.isFinite(n)) onCommit(n)
        setText(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          onCommit(shown + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))
        }
      }}
    />
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Valor mostrado ↔ valor real. */
  show?: (v: number) => number
  parse?: (v: number) => number
  suffix?: string
  onChange: (v: number) => void
  live?: Live
  keys?: PropCtl
  reset?: number
}

function Slider(p: SliderProps) {
  const show = p.show ?? ((v) => v)
  const parse = p.parse ?? ((v) => v)
  const clamp = (v: number) => Math.min(p.max, Math.max(p.min, v))
  return (
    <div className="row">
      <label>
        {p.label}
        {p.keys && <KeyButtons ctl={p.keys} />}
      </label>
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step ?? 0.01}
        value={p.value}
        onPointerDown={() => p.live?.begin()}
        onPointerUp={() => p.live?.end()}
        onChange={(e) => p.onChange(Number(e.target.value))}
        onDoubleClick={() => p.reset !== undefined && p.onChange(p.reset)}
      />
      <NumberInput value={show(p.value)} suffix={p.suffix} onCommit={(n) => p.onChange(clamp(parse(n)))} />
    </div>
  )
}

/** Slider conectado a una propiedad del clip, con keyframes si es animable. */
function PropSlider({ clip, prop, label, min, max, step, show, parse, suffix, keyframes = true, reset, fallback }: {
  clip: Clip
  prop: KeyProp
  label: string
  min: number
  max: number
  step?: number
  show?: (v: number) => number
  parse?: (v: number) => number
  suffix?: string
  keyframes?: boolean
  reset?: number
  fallback?: number
}) {
  const ctl = useProp(clip, prop, fallback)
  return (
    <Slider
      label={label}
      value={ctl.value}
      min={min}
      max={max}
      step={step}
      show={show}
      parse={parse}
      suffix={suffix}
      onChange={ctl.set}
      live={ctl.live}
      keys={keyframes ? ctl : undefined}
      reset={reset}
    />
  )
}

function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button className={`switch ${on ? 'on' : ''}`} title={title} onClick={() => onChange(!on)} />
}

function Group({ title, children, onReset, badge, toggle, open: openDefault = true }: {
  title: string
  children?: React.ReactNode
  onReset?: () => void
  badge?: string
  toggle?: { on: boolean; set: (v: boolean) => void }
  open?: boolean
}) {
  const [open, setOpen] = useState(openDefault)
  const visible = toggle ? toggle.on && open : open
  return (
    <div className="group">
      <div className="group-head">
        {toggle && <input type="checkbox" className="chk" checked={toggle.on} onChange={(e) => toggle.set(e.target.checked)} />}
        <button className="group-title" onClick={() => setOpen(!open)}>
          {title} <span className={`caret ${visible ? 'open' : ''}`}>▴</span>
        </button>
        {badge && <span className="badge">{badge}</span>}
        <span className="spacer" />
        {onReset && (
          <button className="icon-btn" title="Restablecer" onClick={onReset}>
            <Icon name="undo" size={14} />
          </button>
        )}
      </div>
      {visible && children}
    </div>
  )
}

const pct = (v: number) => v * 100
const fromPct = (v: number) => v / 100
const dispatch = (op: Op | Op[]) => {
  try {
    useEditor.getState().dispatch(op)
  } catch {
    /* operación inválida para este clip */
  }
}
const update = (clip: Clip, patch: ClipPatch) => dispatch({ op: 'updateClip', clipId: clip.id, patch })

// --- Básico: transformación, mezcla, recorte, iluminación ------------------------------

function RotationDial({ value, onChange, live }: { value: number; onChange: (v: number) => void; live: Live }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = (e: React.PointerEvent) => {
    live.begin()
    const r = ref.current!.getBoundingClientRect()
    const at = (ev: { clientX: number; clientY: number }) => {
      const a = (Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180) / Math.PI
      onChange(Math.round(((a + 90 + 540) % 360) - 180))
    }
    at(e)
    const move = (ev: PointerEvent) => at(ev)
    const up = () => {
      live.end()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="dial" ref={ref} onPointerDown={drag} title="Arrastra para girar">
      <span style={{ transform: `rotate(${value}deg)` }} />
    </div>
  )
}

function Transform({ clip, project }: { clip: MediaClip | TextClip; project: Project }) {
  const t = clip.transform
  const scale = useProp(clip, 'transform.scale', 1)
  const scaleY = useProp(clip, 'transform.scaleY', 1)
  const x = useProp(clip, 'transform.x')
  const y = useProp(clip, 'transform.y')
  const rot = useProp(clip, 'transform.rotation')
  const uniform = t.scaleY === null
  const W = project.canvas.width
  const H = project.canvas.height

  // Tamaño del clip en el lienzo, para alinear sus bordes con los del lienzo.
  const size = (): [number, number] => {
    if (clip.type !== 'media') return [W * 0.3, H * 0.1]
    const m = project.media[clip.mediaId]
    const fit = Math.min(W / (m.width ?? W), H / (m.height ?? H))
    return [(m.width ?? W) * fit * scale.value, (m.height ?? H) * fit * (uniform ? scale.value : scaleY.value)]
  }
  const align = (axis: 'x' | 'y', where: -1 | 0 | 1) => {
    const [w, h] = size()
    const v = where === 0 ? 0 : axis === 'x' ? where * (1 - w / W) : where * (1 - h / H)
    ;(axis === 'x' ? x : y).set(v)
  }

  return (
    <Group
      title="Transformación"
      onReset={() =>
        dispatch([
          { op: 'clearKeyframes', clipId: clip.id, prop: 'transform.x' },
          { op: 'clearKeyframes', clipId: clip.id, prop: 'transform.y' },
          { op: 'clearKeyframes', clipId: clip.id, prop: 'transform.scale' },
          { op: 'clearKeyframes', clipId: clip.id, prop: 'transform.rotation' },
          { op: 'updateClip', clipId: clip.id, patch: { transform: { ...defaultTransform(), opacity: t.opacity, flipX: t.flipX, flipY: t.flipY } } }
        ])
      }
    >
      <Slider label={uniform ? 'Escala' : 'Escala X'} value={scale.value} min={0.05} max={5} show={pct} parse={fromPct} suffix="%" onChange={scale.set} live={scale.live} keys={scale} reset={1} />
      {!uniform && <Slider label="Escala Y" value={scaleY.value} min={0.05} max={5} show={pct} parse={fromPct} suffix="%" onChange={scaleY.set} live={scaleY.live} keys={scaleY} reset={1} />}
      <div className="row-inline">
        <span className="lbl">Escala uniforme</span>
        <Toggle on={uniform} onChange={(on) => update(clip, { transform: { scaleY: on ? null : t.scale } })} />
      </div>
      <div className="row-inline">
        <span className="lbl">
          Posición
          <KeyButtons ctl={x.hasKeys || !y.hasKeys ? x : y} />
        </span>
        <span className="pair">
          <span className="axis">X</span>
          <NumberInput value={Math.round((x.value * W) / 2)} width={64} onCommit={(n) => x.set((n * 2) / W)} />
          <span className="axis">Y</span>
          <NumberInput value={Math.round((y.value * H) / 2)} width={64} onCommit={(n) => y.set((n * 2) / H)} />
        </span>
      </div>
      <div className="row-inline">
        <span className="lbl">
          Girar
          <KeyButtons ctl={rot} />
        </span>
        <span className="pair">
          <NumberInput value={rot.value} suffix="°" width={70} onCommit={rot.set} />
          <RotationDial value={rot.value} onChange={rot.set} live={rot.live} />
        </span>
      </div>
      <div className="align-row">
        {(
          [
            ['alignLeft', 'x', -1, 'Alinear a la izquierda'],
            ['alignCenterH', 'x', 0, 'Centrar horizontalmente'],
            ['alignRight', 'x', 1, 'Alinear a la derecha'],
            ['alignTop', 'y', -1, 'Alinear arriba'],
            ['alignCenterV', 'y', 0, 'Centrar verticalmente'],
            ['alignBottom', 'y', 1, 'Alinear abajo']
          ] as const
        ).map(([icon, axis, where, title]) => (
          <button key={icon} className="icon-btn" title={title} onClick={() => align(axis, where)}>
            <Icon name={icon} size={15} />
          </button>
        ))}
        <span className="spacer" />
        <button className={`icon-btn ${t.flipX ? 'on' : ''}`} title="Espejo horizontal" onClick={() => update(clip, { transform: { flipX: !t.flipX } })}>
          <Icon name="mirror" size={15} />
        </button>
      </div>
    </Group>
  )
}

function Blend({ clip }: { clip: MediaClip | TextClip }) {
  const opacity = useProp(clip, 'transform.opacity', 1)
  return (
    <Group title="Mezcla" onReset={() => dispatch([{ op: 'clearKeyframes', clipId: clip.id, prop: 'transform.opacity' }, { op: 'updateClip', clipId: clip.id, patch: { blend: 'normal', transform: { opacity: 1 } } }])}>
      <div className="field">
        <span>Modo</span>
        <select value={clip.blend} onChange={(e) => update(clip, { blend: e.target.value as Clip['blend'] })}>
          {BLENDS.map((b) => (
            <option key={b.mode} value={b.mode}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      <Slider label="Opacidad" value={opacity.value} min={0} max={1} show={pct} parse={fromPct} suffix="%" onChange={opacity.set} live={opacity.live} keys={opacity} reset={1} />
    </Group>
  )
}

function CropGroup({ clip }: { clip: MediaClip }) {
  const live = useLive()
  const c = clip.crop
  const set = (k: keyof typeof c, v: number) => live.set({ op: 'updateClip', clipId: clip.id, patch: { crop: { [k]: v } } })
  const active = c.left + c.top + c.right + c.bottom > 0
  return (
    <Group title="Recortar" open={active} onReset={() => update(clip, { crop: defaultCrop() })}>
      {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
        <Slider
          key={k}
          label={{ left: 'Izquierda', right: 'Derecha', top: 'Arriba', bottom: 'Abajo' }[k]}
          value={c[k]}
          min={0}
          max={0.9}
          show={pct}
          parse={fromPct}
          suffix="%"
          onChange={(v) => set(k, v)}
          live={live}
          reset={0}
        />
      ))}
    </Group>
  )
}

function LightGroup({ clip }: { clip: MediaClip }) {
  const l = clip.light
  return (
    <Group
      title="Adición de iluminación"
      toggle={{ on: l.enabled, set: (on) => update(clip, { light: { enabled: on } }) }}
      onReset={() => update(clip, { light: { ...defaultLight(), enabled: l.enabled } })}
    >
      <div className="row-inline">
        <span className="lbl">Color de la luz</span>
        <input className="color-in" type="color" value={l.color} onChange={(e) => update(clip, { light: { color: e.target.value } })} />
      </div>
      <PropSlider clip={clip} prop="light.intensity" label="Intensidad" min={0} max={1.5} show={pct} parse={fromPct} suffix="%" />
      <PropSlider clip={clip} prop="light.x" label="Posición horizontal" min={-1.5} max={1.5} show={(v) => Math.round(v * 50)} parse={(v) => v / 50} reset={-0.4} />
      <PropSlider clip={clip} prop="light.y" label="Posición vertical" min={-1.5} max={1.5} show={(v) => Math.round(v * 50)} parse={(v) => v / 50} reset={-0.4} />
      <Slider label="Tamaño" value={l.radius} min={0.1} max={2} show={pct} parse={fromPct} suffix="%" onChange={(v) => update(clip, { light: { radius: v } })} reset={0.8} />
      <div className="row-inline">
        <span className="lbl">Iluminar solo a la persona</span>
        <Toggle on={l.subjectOnly} onChange={(v) => update(clip, { light: { subjectOnly: v } })} />
      </div>
    </Group>
  )
}

function TransitionGroup({ clip }: { clip: MediaClip }) {
  if (!clip.transition) return null
  const tr = clip.transition
  return (
    <Group title="Transición al siguiente clip" onReset={() => applyTransition(clip.id, null)}>
      <div className="field">
        <span>Tipo</span>
        <select value={tr.kind} onChange={(e) => applyTransition(clip.id, { ...tr, kind: e.target.value as TransitionKind })}>
          {TRANSITIONS.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <Slider label="Duración" value={tr.duration / US} min={0.1} max={3} step={0.1} suffix="s" onChange={(v) => applyTransition(clip.id, { ...tr, duration: Math.round(v * US) })} />
      <div className="hint">El botón de restablecer quita la transición.</div>
    </Group>
  )
}

// --- Fondo, máscara y retoque ------------------------------------------------------------

function BackgroundTab({ clip }: { clip: MediaClip }) {
  const bg = clip.background
  const live = useLive()
  return (
    <div className="insp-body">
      <Group title="Eliminación automática" toggle={{ on: bg.mode === 'auto', set: (on) => update(clip, { background: { mode: on ? 'auto' : 'none' } }) }}>
        <div className="hint">Recorta a la persona con IA local (en tu tarjeta gráfica, sin nube).</div>
        <Slider label="Suavizar borde" value={bg.feather} min={0} max={1} show={pct} parse={fromPct} suffix="%" onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { background: { feather: v } } })} live={live} reset={0.3} />
        <Slider label="Ajustar borde" value={bg.shrink} min={-1} max={1} show={(v) => Math.round(v * 50)} parse={(v) => v / 50} onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { background: { shrink: v } } })} live={live} reset={0} />
      </Group>
      <Group title="Chroma key" toggle={{ on: bg.mode === 'chroma', set: (on) => update(clip, { background: { mode: on ? 'chroma' : 'none' } }) }}>
        <div className="row-inline">
          <span className="lbl">Color a quitar</span>
          <input className="color-in" type="color" value={bg.chroma.color} onChange={(e) => update(clip, { background: { chroma: { color: e.target.value } } })} />
        </div>
        <Slider label="Intensidad" value={bg.chroma.intensity} min={0} max={1} show={pct} parse={fromPct} suffix="%" onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { background: { chroma: { intensity: v } } } })} live={live} />
        <Slider label="Sombra" value={bg.chroma.shadow} min={0} max={1} show={pct} parse={fromPct} suffix="%" onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { background: { chroma: { shadow: v } } } })} live={live} />
      </Group>
    </div>
  )
}

function MaskTab({ clip }: { clip: MediaClip }) {
  const m = clip.mask
  return (
    <div className="insp-body">
      <div className="mask-grid">
        {MASKS.map((s) => (
          <button key={s.shape} className={`mask-tile ${m.shape === s.shape ? 'active' : ''}`} onClick={() => update(clip, { mask: { shape: s.shape } })}>
            <MaskIcon shape={s.shape} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      {m.shape !== 'none' && (
        <Group title="Ajustes de la máscara" onReset={() => update(clip, { mask: { ...defaultMask(), shape: m.shape } })}>
          <PropSlider clip={clip} prop="mask.x" label="Posición X" min={-1.5} max={1.5} show={(v) => Math.round(v * 50)} parse={(v) => v / 50} reset={0} />
          <PropSlider clip={clip} prop="mask.y" label="Posición Y" min={-1.5} max={1.5} show={(v) => Math.round(v * 50)} parse={(v) => v / 50} reset={0} />
          {m.shape !== 'linear' && <PropSlider clip={clip} prop="mask.width" label={m.shape === 'mirror' ? 'Ancho' : 'Ancho'} min={0.02} max={2} show={pct} parse={fromPct} suffix="%" />}
          {m.shape !== 'linear' && <PropSlider clip={clip} prop="mask.height" label={m.shape === 'mirror' ? 'Grosor' : 'Alto'} min={0.02} max={2} show={pct} parse={fromPct} suffix="%" />}
          <PropSlider clip={clip} prop="mask.rotation" label="Rotación" min={-180} max={180} step={1} suffix="°" reset={0} />
          <PropSlider clip={clip} prop="mask.feather" label="Difuminar" min={0} max={1} show={pct} parse={fromPct} suffix="%" />
          {m.shape === 'rectangle' && <Slider label="Redondez" value={m.roundness} min={0} max={1} show={pct} parse={fromPct} suffix="%" onChange={(v) => update(clip, { mask: { roundness: v } })} />}
          <div className="row-inline">
            <span className="lbl">Invertir</span>
            <Toggle on={m.invert} onChange={(v) => update(clip, { mask: { invert: v } })} />
          </div>
        </Group>
      )}
    </div>
  )
}

function MaskIcon({ shape }: { shape: string }) {
  const d: Record<string, string> = {
    none: 'M5 5l14 14M19 5L5 19',
    linear: 'M3 12h18',
    mirror: 'M3 9h18M3 15h18',
    circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
    rectangle: 'M4 6h16v12H4z',
    heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
    star: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z'
  }
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d={d[shape]} />
    </svg>
  )
}

function RetouchTab({ clip }: { clip: MediaClip }) {
  const r = clip.retouch
  const live = useLive()
  const set = (k: keyof typeof r, v: number) => live.set({ op: 'updateClip', clipId: clip.id, patch: { retouch: { [k]: v } } })
  return (
    <div className="insp-body">
      <Group title="Piel" onReset={() => update(clip, { retouch: defaultRetouch() })}>
        <div className="hint">Detecta la piel de cara y cuerpo con IA local y la retoca sin tocar ojos, cejas ni boca.</div>
        <Slider label="Suavizar" value={r.smooth} min={0} max={1} show={pct} parse={fromPct} onChange={(v) => set('smooth', v)} live={live} reset={0} />
        <Slider label="Borrar imperfecciones" value={r.removeBlemishes} min={0} max={1} show={pct} parse={fromPct} onChange={(v) => set('removeBlemishes', v)} live={live} reset={0} />
        <Slider label="Blanqueamiento" value={r.whiten} min={0} max={1} show={pct} parse={fromPct} onChange={(v) => set('whiten', v)} live={live} reset={0} />
        <Slider label="Tono uniforme" value={r.evenTone} min={0} max={1} show={pct} parse={fromPct} onChange={(v) => set('evenTone', v)} live={live} reset={0} />
      </Group>
    </div>
  )
}

function VideoTab({ clip, project }: { clip: MediaClip; project: Project }) {
  const [sub, setSub] = useState<'basic' | 'bg' | 'mask' | 'retouch'>('basic')
  return (
    <>
      <div className="subtabs">
        <button className={sub === 'basic' ? 'active' : ''} onClick={() => setSub('basic')}>Básico</button>
        <button className={sub === 'bg' ? 'active' : ''} onClick={() => setSub('bg')}>Eliminar fondo</button>
        <button className={sub === 'mask' ? 'active' : ''} onClick={() => setSub('mask')}>Máscara</button>
        <button className={sub === 'retouch' ? 'active' : ''} onClick={() => setSub('retouch')}>Retoque</button>
      </div>
      {sub === 'basic' && (
        <div className="insp-body">
          <Transform clip={clip} project={project} />
          <Blend clip={clip} />
          <LightGroup clip={clip} />
          <CropGroup clip={clip} />
          <TransitionGroup clip={clip} />
        </div>
      )}
      {sub === 'bg' && <BackgroundTab clip={clip} />}
      {sub === 'mask' && <MaskTab clip={clip} />}
      {sub === 'retouch' && <RetouchTab clip={clip} />}
    </>
  )
}

// --- Audio, velocidad, animación, ajustes, texto, efectos --------------------------------

function AudioTab({ clip }: { clip: MediaClip }) {
  const fx = clip.audioFx
  const vol = useProp(clip, 'volume', 1)
  const maxFade = clip.duration / US / 2
  const live = useLive()
  const toggle = (key: keyof typeof fx, label: string, hint: string) => (
    <div className="group">
      <label className="check">
        <input type="checkbox" checked={fx[key]} onChange={(e) => update(clip, { audioFx: { [key]: e.target.checked } })} />
        <b>{label}</b>
      </label>
      <div className="hint">{hint}</div>
    </div>
  )
  return (
    <div className="insp-body">
      <Group title="Básico" onReset={() => dispatch([{ op: 'clearKeyframes', clipId: clip.id, prop: 'volume' }, { op: 'updateClip', clipId: clip.id, patch: { volume: 1, fadeIn: 0, fadeOut: 0 } }])}>
        <Slider label="Volumen" value={gainToDb(vol.value)} min={-60} max={20} step={0.1} suffix="dB" onChange={(db) => vol.set(dbToGain(db))} live={vol.live} keys={vol} reset={0} />
        <Slider label="Aparición progresiva" value={clip.fadeIn / US} min={0} max={maxFade} step={0.1} suffix="s" onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { fadeIn: Math.round(v * US) } })} live={live} reset={0} />
        <Slider label="Desaparición progresiva" value={clip.fadeOut / US} min={0} max={maxFade} step={0.1} suffix="s" onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { fadeOut: Math.round(v * US) } })} live={live} reset={0} />
      </Group>
      {toggle('normalize', 'Normalizar la intensidad', 'Lleva el clip a −14 LUFS, el nivel de TikTok, Instagram y YouTube.')}
      {toggle('enhanceVoice', 'Mejorar voz', 'Limpia graves, da presencia y comprime para una voz más clara y pareja.')}
      {toggle('denoise', 'Reducir el ruido', 'Quita el ruido de fondo constante (ventilador, aire, zumbido).')}
      {toggle('isolateVoice', 'Aislar voz', 'Reducción de ruido fuerte y filtro de banda de voz.')}
      <div className="hint">Los efectos de audio se aplican al exportar; la vista previa suena sin ellos.</div>
    </div>
  )
}

function SpeedTab({ clip }: { clip: MediaClip }) {
  const live = useLive()
  return (
    <div className="insp-body">
      <Group title="Normal" onReset={() => update(clip, { speed: 1 })}>
        <Slider label="Velocidad" value={clip.speed} min={0.1} max={10} step={0.05} suffix="x" onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { speed: Math.round(v * 100) / 100 } })} live={live} reset={1} />
        <div className="hint">Duración: {(clip.duration / US).toFixed(1)}s</div>
      </Group>
    </div>
  )
}

function AnimationTab({ clip }: { clip: Clip }) {
  const [kind, setKind] = useState<'in' | 'out' | 'combo'>('in')
  const current = clip.animations[kind]
  const list = kind === 'combo' ? COMBOS : ANIMATIONS
  const set = (name: string | null) =>
    update(clip, { animations: { [kind]: name ? { name, duration: current?.duration ?? (kind === 'combo' ? 1 * US : DEFAULT_ANIMATION_US) } : null } })
  return (
    <div className="insp-body">
      <div className="subtabs" style={{ margin: '10px 0' }}>
        <button className={kind === 'in' ? 'active' : ''} onClick={() => setKind('in')}>Entrada</button>
        <button className={kind === 'out' ? 'active' : ''} onClick={() => setKind('out')}>Salida</button>
        <button className={kind === 'combo' ? 'active' : ''} onClick={() => setKind('combo')}>Combo</button>
      </div>
      <div className="anim-grid">
        <button className={`anim-tile ${!current ? 'active' : ''}`} onClick={() => set(null)}>
          <Icon name="close" size={18} />
          <span>Ninguna</span>
        </button>
        {list.map((a) => (
          <button key={a.name} className={`anim-tile ${current?.name === a.name ? 'active' : ''}`} onClick={() => set(a.name)}>
            <span className={`anim-demo ${kind}-${a.name}`} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      {current && (
        <Slider
          label={kind === 'combo' ? 'Ciclo' : 'Duración'}
          value={current.duration / US}
          min={0.1}
          max={Math.max(0.2, kind === 'combo' ? 4 : clip.duration / US)}
          step={0.1}
          suffix="s"
          onChange={(v) => update(clip, { animations: { [kind]: { name: current.name, duration: Math.round(v * US) } } })}
        />
      )}
    </div>
  )
}

const ADJUST_FIELDS: { key: keyof Adjust; label: string; min?: number }[] = [
  { key: 'brightness', label: 'Brillo' },
  { key: 'contrast', label: 'Contraste' },
  { key: 'saturation', label: 'Saturación' },
  { key: 'exposure', label: 'Exposición' },
  { key: 'temperature', label: 'Temperatura' },
  { key: 'tint', label: 'Tono' },
  { key: 'highlights', label: 'Luces' },
  { key: 'shadows', label: 'Sombras' },
  { key: 'sharpen', label: 'Nitidez', min: 0 },
  { key: 'vignette', label: 'Viñeta', min: 0 }
]

function AdjustTab({ clip }: { clip: MediaClip | AdjustClip }) {
  const [luts, setLuts] = useState<LutEntry[]>([])
  useEffect(() => {
    void api.listLuts().then(setLuts)
  }, [])
  const lut = clip.color.lut
  return (
    <div className="insp-body">
      <Group title="LUT">
        <div className="field">
          <span>Nombre</span>
          <select
            value={lut?.path ?? ''}
            onChange={(e) => {
              const l = luts.find((x) => x.path === e.target.value)
              dispatch({ op: 'setLut', clipId: clip.id, lut: l ? { path: l.path, name: l.name, intensity: lut?.intensity ?? 1 } : null })
            }}
          >
            <option value="">Ninguno</option>
            {luts.map((l) => (
              <option key={l.path} value={l.path}>
                {l.name}.cube
              </option>
            ))}
          </select>
        </div>
        {lut && <PropSlider clip={clip} prop="color.lut.intensity" label="Intensidad" min={0} max={1} show={pct} parse={fromPct} reset={1} />}
        <div className="row-inline">
          <span className="lbl">
            <span>
              Proteger el tono de la piel
              <span className="hint" style={{ display: 'block' }}>Los tonos de piel se ven más naturales con el LUT.</span>
            </span>
          </span>
          <Toggle on={clip.color.protectSkin} onChange={(v) => update(clip, { color: { protectSkin: v } })} />
        </div>
      </Group>
      <Group
        title="Ajustes básicos"
        onReset={() =>
          dispatch([
            ...ADJUST_FIELDS.map((f) => ({ op: 'clearKeyframes', clipId: clip.id, prop: `color.adjust.${f.key}` }) as Op),
            { op: 'updateClip', clipId: clip.id, patch: { color: { adjust: defaultAdjust() } } }
          ])
        }
      >
        {ADJUST_FIELDS.map((f) => (
          <PropSlider
            key={f.key}
            clip={clip}
            prop={`color.adjust.${f.key}`}
            label={f.label}
            min={f.min ?? -1}
            max={1}
            show={(v) => Math.round(v * 50)}
            parse={(v) => v / 50}
            reset={0}
          />
        ))}
      </Group>
    </div>
  )
}

function TextTab({ clip }: { clip: TextClip }) {
  const st = clip.style
  const live = useLive()
  return (
    <div className="insp-body">
      <div className="field">
        <span>Texto</span>
        <textarea value={clip.text} onChange={(e) => update(clip, { text: e.target.value })} />
      </div>
      <div className="field">
        <span>Fuente</span>
        <select value={st.font} onChange={(e) => update(clip, { style: { font: e.target.value } })}>
          {['Arial', 'Impact', 'Verdana', 'Georgia', 'Tahoma', 'Times New Roman', 'Segoe UI', 'Comic Sans MS'].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </div>
      <Slider label="Tamaño" value={st.size} min={8} max={400} step={1} onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { style: { size: Math.round(v) } } })} live={live} />
      <div className="inline" style={{ margin: '8px 0' }}>
        <input className="color-in" type="color" value={st.color} title="Color" onChange={(e) => update(clip, { style: { color: e.target.value } })} />
        <label className="check"><input type="checkbox" checked={st.bold} onChange={(e) => update(clip, { style: { bold: e.target.checked } })} />Negrita</label>
        <label className="check"><input type="checkbox" checked={st.italic} onChange={(e) => update(clip, { style: { italic: e.target.checked } })} />Cursiva</label>
        <select className="num" style={{ width: 90, textAlign: 'left' }} value={st.align} onChange={(e) => update(clip, { style: { align: e.target.value as TextClip['style']['align'] } })}>
          <option value="left">Izquierda</option>
          <option value="center">Centro</option>
          <option value="right">Derecha</option>
        </select>
      </div>
      <Group title="Borde">
        <div className="inline">
          <input className="color-in" type="color" value={st.strokeColor} onChange={(e) => update(clip, { style: { strokeColor: e.target.value } })} />
        </div>
        <Slider label="Grosor" value={st.strokeWidth} min={0} max={3} step={0.05} show={(v) => Math.round(v * 33)} parse={(v) => v / 33} onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { style: { strokeWidth: v } } })} live={live} />
      </Group>
      <Group title="Fondo" toggle={{ on: Boolean(st.background), set: (on) => update(clip, { style: { background: on ? '#000000' : null } }) }}>
        {st.background && <input className="color-in" type="color" value={st.background} onChange={(e) => update(clip, { style: { background: e.target.value } })} />}
      </Group>
    </div>
  )
}

function EffectTab({ clip }: { clip: EffectClip }) {
  const live = useLive()
  return (
    <div className="insp-body">
      <div className="field">
        <span>Efecto</span>
        <select value={clip.effect} onChange={(e) => update(clip, { effect: e.target.value })}>
          {EFFECTS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <Slider label="Intensidad" value={clip.params.intensity ?? 0.6} min={0} max={1} show={pct} parse={fromPct} onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { params: { intensity: v } } })} live={live} reset={0.6} />
      <Slider label="Velocidad" value={clip.params.speed ?? 0.5} min={0} max={1} show={pct} parse={fromPct} onChange={(v) => live.set({ op: 'updateClip', clipId: clip.id, patch: { params: { speed: v } } })} live={live} reset={0.5} />
    </div>
  )
}

function Details({ project }: { project: Project }) {
  return (
    <>
      <div className="insp-tabs">
        <button className="active">Detalles</button>
      </div>
      <dl className="details">
        <dt>Nombre:</dt>
        <dd>{project.name}</dd>
        <dt>Resolución:</dt>
        <dd>
          {project.canvas.width}×{project.canvas.height}
        </dd>
        <dt>Cuadros por segundo:</dt>
        <dd>
          <select className="num" style={{ width: 90, textAlign: 'left' }} value={project.canvas.fps} onChange={(e) => dispatch({ op: 'setCanvas', fps: Number(e.target.value) })}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f.toFixed(2)}fps
              </option>
            ))}
          </select>
        </dd>
        <dt>Fondo del lienzo:</dt>
        <dd>
          <input className="color-in" type="color" value={project.canvas.background} onChange={(e) => dispatch({ op: 'setCanvas', background: e.target.value })} />
        </dd>
        <dt>Medios:</dt>
        <dd>{Object.keys(project.media).length}</dd>
        <dt>Guardado:</dt>
        <dd>Automático, con respaldos cada 2 minutos</dd>
      </dl>
    </>
  )
}

export function Inspector() {
  const project = useEditor((s) => s.project!)
  const selectionCount = useEditor((s) => s.selection.length)
  const id = useEditor(primarySelection)
  const clip = id ? findClip(project, id)?.clip ?? null : null
  const media = clip?.type === 'media' ? project.media[clip.mediaId] : undefined
  const tabs = !clip
    ? []
    : clip.type === 'text'
      ? ['Texto', 'Básico', 'Animación']
      : clip.type === 'effect'
        ? ['Efecto']
        : clip.type === 'adjust'
          ? ['Ajustar']
        : media?.kind === 'audio'
          ? ['Audio', 'Velocidad']
          : media?.kind === 'image'
            ? ['Video', 'Animación', 'Ajustar']
            : ['Video', 'Audio', 'Velocidad', 'Animación', 'Ajustar']
  const [tab, setTab] = useState('Video')
  const active = tabs.includes(tab) ? tab : tabs[0]

  if (!clip) return <div className="panel inspector"><Details project={project} /></div>

  return (
    <div className="panel inspector">
      <div className="insp-tabs">
        {tabs.map((t) => (
          <button key={t} className={active === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        {selectionCount > 1 && <span className="multi-badge">{selectionCount} seleccionados</span>}
      </div>
      {clip.type === 'text' ? (
        active === 'Texto' ? <TextTab clip={clip} /> : active === 'Básico' ? <div className="insp-body"><Transform clip={clip} project={project} /><Blend clip={clip} /></div> : <AnimationTab clip={clip} />
      ) : clip.type === 'effect' ? (
        <EffectTab clip={clip} />
      ) : clip.type === 'adjust' ? (
        <AdjustTab clip={clip} />
      ) : active === 'Video' ? (
        <VideoTab clip={clip} project={project} />
      ) : active === 'Audio' ? (
        <AudioTab clip={clip} />
      ) : active === 'Velocidad' ? (
        <SpeedTab clip={clip} />
      ) : active === 'Animación' ? (
        <AnimationTab clip={clip} />
      ) : (
        <AdjustTab clip={clip} />
      )}
    </div>
  )
}
