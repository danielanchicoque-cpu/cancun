import { useEffect, useRef, useState } from 'react'
import type { DeepPartial } from '@shared/ops'
import { type Adjust, type MediaClip, type Project, type TextClip, type TransitionKind, US, findClip, defaultAdjust } from '@shared/project'
import { useEditor } from '../store'
import { api, type LutEntry } from '../api'
import { applyTransition } from '../actions'
import { TRANSITIONS } from './LeftPanel'
import { dbToGain, gainToDb } from '../format'
import { Icon } from './icons'

type Patch = DeepPartial<Omit<MediaClip, 'id' | 'type'>> | DeepPartial<Omit<TextClip, 'id' | 'type'>>

/**
 * Los deslizadores cambian el proyecto en vivo; mientras se arrastra se reemplaza
 * el mismo paso del historial, así un arrastre es un solo "deshacer".
 */
function useLivePatch(clipId: string) {
  const base = useRef<Project | null>(null)
  const begin = () => {
    base.current = useEditor.getState().project
  }
  const update = (patch: Patch) => {
    const s = useEditor.getState()
    if (base.current) {
      useEditor.setState({ project: base.current, past: s.past })
      useEditor.getState().dispatch({ op: 'updateClip', clipId, patch })
      useEditor.setState((st) => ({ past: st.past.slice(0, -1) }))
    } else {
      s.dispatch({ op: 'updateClip', clipId, patch })
    }
  }
  const end = () => {
    if (base.current && base.current !== useEditor.getState().project) {
      const b = base.current
      useEditor.setState((st) => ({ past: [...st.past, b] }))
    }
    base.current = null
  }
  return { begin, update, end }
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Cómo se muestra el número (por defecto, el valor tal cual). */
  display?: (v: number) => number
  fromDisplay?: (v: number) => number
  suffix?: string
  onBegin: () => void
  onChange: (v: number) => void
  onEnd: () => void
}) {
  const display = props.display ?? ((v) => v)
  const fromDisplay = props.fromDisplay ?? ((v) => v)
  const [text, setText] = useState<string | null>(null)
  const shown = Math.round(display(props.value) * 100) / 100
  return (
    <div className="row">
      <label>{props.label}</label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        onPointerDown={props.onBegin}
        onPointerUp={props.onEnd}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => {
          props.onBegin()
          props.onChange(fromDisplay(0))
          props.onEnd()
        }}
      />
      <input
        className="num"
        value={text ?? `${shown}${props.suffix ?? ''}`}
        onFocus={(e) => {
          setText(String(shown))
          e.target.select()
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number(text?.replace(',', '.'))
          if (Number.isFinite(n)) {
            props.onBegin()
            props.onChange(Math.min(props.max, Math.max(props.min, fromDisplay(n))))
            props.onEnd()
          }
          setText(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  )
}

function Group({ title, children, onReset, badge }: { title: string; children: React.ReactNode; onReset?: () => void; badge?: string }) {
  return (
    <div className="group">
      <div className="group-head">
        {title}
        {badge && <span className="badge">{badge}</span>}
        <span className="spacer" />
        {onReset && (
          <button className="icon-btn" title="Restablecer" onClick={onReset}>
            <Icon name="undo" size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

const pct = (v: number) => v * 100
const fromPct = (v: number) => v / 100

function TransformControls({ clip, live }: { clip: MediaClip | TextClip; live: ReturnType<typeof useLivePatch> }) {
  const t = clip.transform
  const s = (key: keyof typeof t, label: string, min: number, max: number, display?: (v: number) => number, from?: (v: number) => number, suffix?: string) => (
    <Slider
      label={label}
      value={t[key]}
      min={min}
      max={max}
      display={display}
      fromDisplay={from}
      suffix={suffix}
      onBegin={live.begin}
      onEnd={live.end}
      onChange={(v) => live.update({ transform: { [key]: v } })}
    />
  )
  return (
    <Group title="Transformar" onReset={() => useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch: { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } } })}>
      {s('scale', 'Escala', 0.05, 5, pct, fromPct, '%')}
      {s('x', 'Posición X', -2, 2, (v) => Math.round(v * 960), (v) => v / 960)}
      {s('y', 'Posición Y', -2, 2, (v) => Math.round(v * 540), (v) => v / 540)}
      {s('rotation', 'Rotación', -180, 180, undefined, undefined, '°')}
      {s('opacity', 'Opacidad', 0, 1, pct, fromPct, '%')}
    </Group>
  )
}

function VideoTab({ clip, live }: { clip: MediaClip; live: ReturnType<typeof useLivePatch> }) {
  const [sub, setSub] = useState<'basic' | 'bg' | 'retouch'>('basic')
  const bg = clip.background
  const dispatch = (patch: Patch) => useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch })
  return (
    <>
      <div className="subtabs">
        <button className={sub === 'basic' ? 'active' : ''} onClick={() => setSub('basic')}>Básico</button>
        <button className={sub === 'bg' ? 'active' : ''} onClick={() => setSub('bg')}>Eliminar fondo</button>
        <button className={sub === 'retouch' ? 'active' : ''} onClick={() => setSub('retouch')}>Retoque</button>
      </div>
      <div className="insp-body">
        {sub === 'basic' && <TransformControls clip={clip} live={live} />}
        {sub === 'basic' && clip.transition && (
          <Group title="Transición al siguiente clip" onReset={() => applyTransition(clip.id, null)}>
            <div className="field">
              <span>Tipo</span>
              <select
                value={clip.transition.kind}
                onChange={(e) => applyTransition(clip.id, { ...clip.transition!, kind: e.target.value as TransitionKind })}
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.kind} value={t.kind}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <Slider
              label="Duración"
              value={clip.transition.duration / US}
              min={0.1}
              max={3}
              step={0.1}
              suffix="s"
              onBegin={() => undefined}
              onEnd={() => undefined}
              onChange={(v) => applyTransition(clip.id, { ...clip.transition!, duration: Math.round(v * US) })}
            />
            <div className="hint">El botón de restablecer quita la transición.</div>
          </Group>
        )}
        {sub === 'bg' && (
          <>
            <Group title="Eliminación automática" badge="Próximamente">
              <div className="hint">Quitará el fondo con IA en tu propio equipo, sin nube ni pago. Es lo siguiente que se construye.</div>
            </Group>
            <Group title="Chroma key">
              <label className="check">
                <input type="checkbox" checked={bg.mode === 'chroma'} onChange={(e) => dispatch({ background: { mode: e.target.checked ? 'chroma' : 'none' } })} />
                Activar
              </label>
              {bg.mode === 'chroma' && (
                <>
                  <div className="field">
                    <span>Color a quitar</span>
                    <input className="color-in" type="color" value={bg.chroma.color} onChange={(e) => dispatch({ background: { chroma: { color: e.target.value } } })} />
                  </div>
                  <Slider label="Intensidad" value={bg.chroma.intensity} min={0} max={1} display={pct} fromDisplay={fromPct} onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ background: { chroma: { intensity: v } } })} />
                  <Slider label="Sombra" value={bg.chroma.shadow} min={0} max={1} display={pct} fromDisplay={fromPct} onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ background: { chroma: { shadow: v } } })} />
                </>
              )}
            </Group>
          </>
        )}
        {sub === 'retouch' && (
          <Group title="Piel" badge="Próximamente">
            <div className="hint">
              Suavizar, borrar imperfecciones, blanqueamiento y tono uniforme con detección de rostro local. Se construye junto con la eliminación automática de fondo.
            </div>
          </Group>
        )}
      </div>
    </>
  )
}

function AudioTab({ clip, live }: { clip: MediaClip; live: ReturnType<typeof useLivePatch> }) {
  const fx = clip.audioFx
  const dispatch = (patch: Patch) => useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch })
  const maxFade = clip.duration / US / 2
  const toggle = (key: keyof typeof fx, label: string, hint: string) => (
    <div className="group">
      <label className="check">
        <input type="checkbox" checked={fx[key]} onChange={(e) => dispatch({ audioFx: { [key]: e.target.checked } })} />
        <b>{label}</b>
      </label>
      <div className="hint">{hint}</div>
    </div>
  )
  return (
    <div className="insp-body">
      <Group title="Básico" onReset={() => dispatch({ volume: 1, fadeIn: 0, fadeOut: 0 })}>
        <Slider label="Volumen" value={gainToDb(clip.volume)} min={-60} max={20} step={0.1} suffix="dB" onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ volume: dbToGain(v) })} />
        <Slider label="Aparición progresiva" value={clip.fadeIn / US} min={0} max={maxFade} step={0.1} suffix="s" onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ fadeIn: Math.round(v * US) })} />
        <Slider label="Desaparición progresiva" value={clip.fadeOut / US} min={0} max={maxFade} step={0.1} suffix="s" onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ fadeOut: Math.round(v * US) })} />
      </Group>
      {toggle('normalize', 'Normalizar la intensidad', 'Lleva el clip a −14 LUFS, el nivel que usan TikTok, Instagram y YouTube.')}
      {toggle('enhanceVoice', 'Mejorar voz', 'Limpia graves, da presencia y comprime para una voz más clara y pareja.')}
      {toggle('denoise', 'Reducir el ruido', 'Quita el ruido de fondo constante (ventilador, aire, zumbido).')}
      {toggle('isolateVoice', 'Aislar voz', 'Reducción de ruido fuerte y filtro de banda de voz.')}
      <div className="hint">Los efectos de audio se aplican al exportar; la vista previa suena sin ellos por ahora.</div>
    </div>
  )
}

function SpeedTab({ clip, live }: { clip: MediaClip; live: ReturnType<typeof useLivePatch> }) {
  return (
    <div className="insp-body">
      <Group title="Normal" onReset={() => useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch: { speed: 1 } })}>
        <Slider label="Velocidad" value={clip.speed} min={0.1} max={10} step={0.05} suffix="x" onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ speed: Math.round(v * 100) / 100 })} />
        <div className="hint">Duración: {(clip.duration / US).toFixed(1)}s</div>
      </Group>
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

function AdjustTab({ clip, live }: { clip: MediaClip; live: ReturnType<typeof useLivePatch> }) {
  const [luts, setLuts] = useState<LutEntry[]>([])
  useEffect(() => {
    void api.listLuts().then(setLuts)
  }, [])
  const lut = clip.color.lut
  const dispatch = useEditor.getState().dispatch
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
        {lut && (
          <Slider
            label="Intensidad"
            value={lut.intensity}
            min={0}
            max={1}
            display={pct}
            fromDisplay={fromPct}
            onBegin={live.begin}
            onEnd={live.end}
            onChange={(v) => live.update({ color: { lut: { intensity: v } } })}
          />
        )}
      </Group>
      <Group title="Ajustes básicos" onReset={() => dispatch({ op: 'updateClip', clipId: clip.id, patch: { color: { adjust: defaultAdjust() } } })}>
        {ADJUST_FIELDS.map((f) => (
          <Slider
            key={f.key}
            label={f.label}
            value={clip.color.adjust[f.key]}
            min={f.min ?? -1}
            max={1}
            display={(v) => Math.round(v * 50)}
            fromDisplay={(v) => v / 50}
            onBegin={live.begin}
            onEnd={live.end}
            onChange={(v) => live.update({ color: { adjust: { [f.key]: v } } })}
          />
        ))}
      </Group>
    </div>
  )
}

function TextTab({ clip, live }: { clip: TextClip; live: ReturnType<typeof useLivePatch> }) {
  const st = clip.style
  const dispatch = (patch: Patch) => useEditor.getState().dispatch({ op: 'updateClip', clipId: clip.id, patch })
  return (
    <div className="insp-body">
      <div className="field">
        <span>Texto</span>
        <textarea value={clip.text} onChange={(e) => dispatch({ text: e.target.value })} />
      </div>
      <div className="field">
        <span>Fuente</span>
        <select value={st.font} onChange={(e) => dispatch({ style: { font: e.target.value } })}>
          {['Arial', 'Impact', 'Verdana', 'Georgia', 'Tahoma', 'Times New Roman', 'Segoe UI', 'Comic Sans MS'].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </div>
      <Slider label="Tamaño" value={st.size} min={8} max={400} step={1} onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ style: { size: Math.round(v) } })} />
      <div className="inline" style={{ margin: '8px 0' }}>
        <input className="color-in" type="color" value={st.color} title="Color" onChange={(e) => dispatch({ style: { color: e.target.value } })} />
        <label className="check"><input type="checkbox" checked={st.bold} onChange={(e) => dispatch({ style: { bold: e.target.checked } })} />Negrita</label>
        <label className="check"><input type="checkbox" checked={st.italic} onChange={(e) => dispatch({ style: { italic: e.target.checked } })} />Cursiva</label>
        <select className="num" style={{ width: 90, textAlign: 'left' }} value={st.align} onChange={(e) => dispatch({ style: { align: e.target.value as TextClip['style']['align'] } })}>
          <option value="left">Izquierda</option>
          <option value="center">Centro</option>
          <option value="right">Derecha</option>
        </select>
      </div>
      <Group title="Borde">
        <div className="inline">
          <input className="color-in" type="color" value={st.strokeColor} onChange={(e) => dispatch({ style: { strokeColor: e.target.value } })} />
        </div>
        <Slider label="Grosor" value={st.strokeWidth} min={0} max={3} step={0.05} display={(v) => Math.round(v * 33)} fromDisplay={(v) => v / 33} onBegin={live.begin} onEnd={live.end} onChange={(v) => live.update({ style: { strokeWidth: v } })} />
      </Group>
      <Group title="Fondo">
        <label className="check">
          <input type="checkbox" checked={Boolean(st.background)} onChange={(e) => dispatch({ style: { background: e.target.checked ? '#000000' : null } })} />
          Activar
        </label>
        {st.background && <input className="color-in" type="color" value={st.background} onChange={(e) => dispatch({ style: { background: e.target.value } })} />}
      </Group>
      <TransformControls clip={clip} live={live} />
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
          <select
            className="num"
            style={{ width: 90, textAlign: 'left' }}
            value={project.canvas.fps}
            onChange={(e) => useEditor.getState().dispatch({ op: 'setCanvas', fps: Number(e.target.value) })}
          >
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f.toFixed(2)}fps
              </option>
            ))}
          </select>
        </dd>
        <dt>Fondo del lienzo:</dt>
        <dd>
          <input
            className="color-in"
            type="color"
            value={project.canvas.background}
            onChange={(e) => useEditor.getState().dispatch({ op: 'setCanvas', background: e.target.value })}
          />
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
  const selection = useEditor((s) => s.selection)
  const found = selection ? findClip(project, selection) : null
  const clip = found?.clip ?? null
  const live = useLivePatch(clip?.id ?? '')
  const media = clip?.type === 'media' ? project.media[clip.mediaId] : undefined
  const isAudio = media?.kind === 'audio'
  const tabs = !clip
    ? []
    : clip.type === 'text'
      ? ['Texto']
      : isAudio
        ? ['Audio', 'Velocidad']
        : media?.kind === 'image'
          ? ['Video', 'Ajustar']
          : ['Video', 'Audio', 'Velocidad', 'Ajustar']
  const [tab, setTab] = useState('Video')
  const active = tabs.includes(tab) ? tab : tabs[0]

  if (!clip) return <div className="panel"><Details project={project} /></div>

  return (
    <div className="panel">
      <div className="insp-tabs">
        {tabs.map((t) => (
          <button key={t} className={active === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {clip.type === 'text' ? (
        <TextTab clip={clip} live={live} />
      ) : active === 'Video' ? (
        <VideoTab clip={clip} live={live} />
      ) : active === 'Audio' ? (
        <AudioTab clip={clip} live={live} />
      ) : active === 'Velocidad' ? (
        <SpeedTab clip={clip} live={live} />
      ) : (
        <AdjustTab clip={clip} live={live} />
      )}
    </div>
  )
}
