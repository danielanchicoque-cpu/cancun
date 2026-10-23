import { useEffect, useMemo, useState } from 'react'
import type { Media, TextStyle, TransitionKind } from '@shared/project'
import { useEditor } from '../store'
import { api, mediaUrl, type LutEntry } from '../api'
import { useFilmstrip } from '../assets'
import { DEFAULT_TRANSITION_US, addToTimeline, applyTransition, importFiles, pickAndImport, targetClip, toast } from '../actions'
import { shortTime } from '../format'
import { Icon, type IconName } from './icons'

type Tab = 'media' | 'audio' | 'text' | 'transitions' | 'adjust'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'media', label: 'Archivos multimedia', icon: 'media' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'text', label: 'Texto', icon: 'text' },
  { id: 'transitions', label: 'Transiciones', icon: 'transitions' },
  { id: 'adjust', label: 'Ajuste', icon: 'adjust' }
]

// --- "Tuyos": biblioteca personal que se reutiliza entre proyectos ----------------------
const TUYOS_KEY = 'cancun.tuyos'
function readTuyos(): string[] {
  try {
    return JSON.parse(localStorage.getItem(TUYOS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}
function useTuyos() {
  const [paths, setPaths] = useState(readTuyos)
  const toggle = (path: string) => {
    const next = paths.includes(path) ? paths.filter((p) => p !== path) : [path, ...paths]
    localStorage.setItem(TUYOS_KEY, JSON.stringify(next))
    setPaths(next)
  }
  return { paths, toggle }
}

const probeCache = new Map<string, Promise<Media | null>>()
function useProbed(paths: string[]): Media[] {
  const [list, setList] = useState<Media[]>([])
  useEffect(() => {
    let alive = true
    Promise.all(
      paths.map((p) => {
        let pr = probeCache.get(p)
        if (!pr) {
          pr = api.probe([p]).then((r) => r[0] ?? null).catch(() => null)
          probeCache.set(p, pr)
        }
        return pr
      })
    ).then((r) => alive && setList(r.filter((m): m is Media => Boolean(m))))
    return () => {
      alive = false
    }
  }, [paths.join('|')])
  return list
}

function MediaTile({ media, inProject, starred, onStar }: { media: Media; inProject: boolean; starred: boolean; onStar: () => void }) {
  const strip = useFilmstrip(media)
  const add = async () => {
    const [m] = inProject ? [media] : await importFiles([media.path])
    if (m) addToTimeline(m)
  }
  return (
    <div
      className="asset"
      draggable
      onDragStart={(e) => {
        if (inProject) e.dataTransfer.setData('application/x-cancun-media', media.id)
        else e.dataTransfer.setData('application/x-cancun-path', media.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={add}
      title={media.path}
    >
      <div
        className="thumb"
        style={strip ? { backgroundImage: `url("${strip}")`, backgroundSize: media.kind === 'image' ? 'cover' : 'auto 100%', backgroundPosition: '0 0' } : undefined}
      >
        {media.kind === 'audio' && <Icon name="audio" size={26} />}
        {media.kind !== 'image' && <span className="dur">{shortTime(media.duration)}</span>}
        <span className="add inline">
          <button className={`icon-btn ${starred ? 'on' : ''}`} title={starred ? 'Quitar de Tuyos' : 'Guardar en Tuyos'} onClick={onStar}>
            <Icon name="star" size={14} />
          </button>
          <button className="icon-btn" title="Agregar a la línea de tiempo" onClick={add}>
            <Icon name="plus" size={14} />
          </button>
        </span>
      </div>
      <div className="label">{media.name}</div>
    </div>
  )
}

function MediaBrowser({ kinds, importLabel }: { kinds: Media['kind'][]; importLabel: string }) {
  const media = useEditor((s) => s.project!.media)
  const [section, setSection] = useState<'import' | 'tuyos'>('import')
  const [over, setOver] = useState(false)
  const tuyos = useTuyos()
  const tuyosMedia = useProbed(tuyos.paths).filter((m) => kinds.includes(m.kind))
  const list = Object.values(media).filter((m) => kinds.includes(m.kind))
  const inProject = new Set(list.map((m) => m.path.toLowerCase()))

  return (
    <div className="left-body">
      <div className="side-nav">
        <button className={section === 'import' ? 'active' : ''} onClick={() => setSection('import')}>Importar</button>
        <button className={section === 'tuyos' ? 'active' : ''} onClick={() => setSection('tuyos')}>Tuyos</button>
      </div>
      <div
        className="side-content"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault()
          setOver(false)
          const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean)
          if (paths.length) await importFiles(paths).catch((err) => toast(String(err), true))
        }}
      >
        {section === 'import' ? (
          <>
            <div className={`drop-zone ${over ? 'over' : ''}`} onClick={() => pickAndImport().catch((err) => toast(String(err), true))}>
              <Icon name="plus" /> {importLabel}
              <div className="hint">o arrastra archivos aquí</div>
            </div>
            <div className="asset-grid">
              {list.map((m) => (
                <MediaTile key={m.id} media={m} inProject starred={tuyos.paths.includes(m.path)} onStar={() => tuyos.toggle(m.path)} />
              ))}
            </div>
          </>
        ) : (
          <>
            {tuyosMedia.length === 0 && <div className="empty">Marca con ★ los recursos que quieras reutilizar en otros proyectos.</div>}
            <div className="asset-grid">
              {tuyosMedia.map((m) => (
                <MediaTile key={m.path} media={m} inProject={inProject.has(m.path.toLowerCase())} starred onStar={() => tuyos.toggle(m.path)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const TEXT_PRESETS: { label: string; style: Partial<TextStyle>; sample: string }[] = [
  { label: 'Texto predeterminado', style: {}, sample: 'Texto predeterminado' },
  { label: 'Borde negro', style: { strokeWidth: 1, strokeColor: '#000000' }, sample: 'Borde negro' },
  { label: 'Caja', style: { background: '#000000', color: '#ffffff', bold: true, size: 56 }, sample: 'Caja' },
  { label: 'Amarillo', style: { color: '#ffd400', strokeWidth: 1, strokeColor: '#000000', size: 84 }, sample: 'Amarillo' },
  { label: 'Título', style: { size: 120, bold: true, font: 'Impact' }, sample: 'TÍTULO' }
]

function TextBrowser() {
  const add = (style: Partial<TextStyle>, sample: string) => {
    const s = useEditor.getState()
    const [id] = s.dispatch({ op: 'addText', text: sample, start: s.time, style })
    if (id) s.select(id)
  }
  return (
    <div className="side-content">
      <div className="asset-grid">
        {TEXT_PRESETS.map((p) => (
          <div key={p.label} className="asset" onClick={() => add(p.style, p.sample)}>
            <div className="thumb" style={{ background: '#0c0c0d' }}>
              <span
                style={{
                  color: p.style.color ?? '#fff',
                  fontWeight: p.style.bold === false ? 400 : 700,
                  fontFamily: p.style.font ?? 'Arial',
                  background: p.style.background ?? 'none',
                  padding: p.style.background ? '2px 6px' : 0,
                  WebkitTextStroke: p.style.strokeWidth ? `1px ${p.style.strokeColor}` : undefined,
                  fontSize: 15
                }}
              >
                {p.sample}
              </span>
            </div>
            <div className="label">{p.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const TRANSITIONS: { kind: TransitionKind; label: string; anim: string }[] = [
  { kind: 'fade', label: 'Fundido', anim: 'tr-fade' },
  { kind: 'dissolve', label: 'Disolver', anim: 'tr-fade' },
  { kind: 'fadeblack', label: 'Fundido a negro', anim: 'tr-black' },
  { kind: 'fadewhite', label: 'Destello blanco', anim: 'tr-white' },
  { kind: 'slideleft', label: 'Deslizar ←', anim: 'tr-slide-l' },
  { kind: 'slideright', label: 'Deslizar →', anim: 'tr-slide-r' },
  { kind: 'slideup', label: 'Deslizar ↑', anim: 'tr-slide-u' },
  { kind: 'slidedown', label: 'Deslizar ↓', anim: 'tr-slide-d' },
  { kind: 'wipeleft', label: 'Barrido ←', anim: 'tr-wipe-l' },
  { kind: 'wiperight', label: 'Barrido →', anim: 'tr-wipe-r' },
  { kind: 'smoothleft', label: 'Barrido suave', anim: 'tr-wipe-l' },
  { kind: 'circleopen', label: 'Círculo abrir', anim: 'tr-circle' },
  { kind: 'circleclose', label: 'Círculo cerrar', anim: 'tr-circle' },
  { kind: 'zoomin', label: 'Acercar', anim: 'tr-zoom' },
  { kind: 'radial', label: 'Radial', anim: 'tr-fade' },
  { kind: 'pixelize', label: 'Pixelar', anim: 'tr-fade' }
]

function TransitionBrowser() {
  const apply = (kind: TransitionKind) => {
    const p = useEditor.getState().project!
    const clip = targetClip(p)
    if (!clip) return toast('Selecciona un clip de la pista principal (o pon el cursor sobre uno)', true)
    applyTransition(clip.id, { kind, duration: DEFAULT_TRANSITION_US })
  }
  return (
    <div className="side-content">
      <style>{`
        .transition-tile:hover .tr-b { animation: var(--anim) 1.2s ease-in-out infinite alternate; }
        .tr-b { opacity: 0; }
        @keyframes tr-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes tr-black { 0% { opacity: 0; filter: brightness(0) } 50% { opacity: 1; filter: brightness(0) } 100% { opacity: 1; filter: none } }
        @keyframes tr-white { 0% { opacity: 0; filter: brightness(4) } 50% { opacity: 1; filter: brightness(4) } 100% { opacity: 1; filter: none } }
        @keyframes tr-slide-l { from { opacity: 1; transform: translateX(100%) } to { opacity: 1; transform: none } }
        @keyframes tr-slide-r { from { opacity: 1; transform: translateX(-100%) } to { opacity: 1; transform: none } }
        @keyframes tr-slide-u { from { opacity: 1; transform: translateY(100%) } to { opacity: 1; transform: none } }
        @keyframes tr-slide-d { from { opacity: 1; transform: translateY(-100%) } to { opacity: 1; transform: none } }
        @keyframes tr-wipe-l { from { opacity: 1; clip-path: inset(0 0 0 100%) } to { opacity: 1; clip-path: inset(0) } }
        @keyframes tr-wipe-r { from { opacity: 1; clip-path: inset(0 100% 0 0) } to { opacity: 1; clip-path: inset(0) } }
        @keyframes tr-circle { from { opacity: 1; clip-path: circle(0%) } to { opacity: 1; clip-path: circle(75%) } }
        @keyframes tr-zoom { from { opacity: 0; transform: scale(1.6) } to { opacity: 1; transform: none } }
      `}</style>
      <div className="hint" style={{ marginBottom: 8 }}>Clic para aplicar al clip seleccionado, o arrástrala entre dos clips.</div>
      <div className="asset-grid">
        {TRANSITIONS.map((t) => (
          <div
            key={t.kind}
            className="asset transition-tile"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-cancun-transition', t.kind)}
            onClick={() => apply(t.kind)}
          >
            <div className="thumb" style={{ ['--anim' as string]: t.anim }}>
              <div className="tr-a" />
              <div className="tr-b" />
            </div>
            <div className="label">{t.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LutBrowser() {
  const [luts, setLuts] = useState<LutEntry[]>([])
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project!)
  const current = useMemo(() => targetClip(project)?.color.lut?.path ?? null, [project, selection])
  const refresh = () => api.listLuts().then(setLuts)
  useEffect(() => {
    void api.syncLuts().finally(refresh)
  }, [])

  const apply = (l: LutEntry) => {
    const s = useEditor.getState()
    const clip = targetClip(s.project!)
    if (!clip) return toast('Selecciona un clip de video para aplicarle el LUT', true)
    const same = clip.color.lut?.path === l.path
    s.dispatch({ op: 'setLut', clipId: clip.id, lut: same ? null : { path: l.path, name: l.name, intensity: clip.color.lut?.intensity ?? 1 } })
  }

  return (
    <div className="left-body">
      <div className="side-nav">
        <button className="active">LUT</button>
      </div>
      <div className="side-content">
        <button className="btn" onClick={() => api.importLuts().then(refresh).catch((e) => toast(String(e), true))}>
          <Icon name="plus" size={12} /> Importar
        </button>
        <div className="asset-grid">
          {luts.map((l) => (
            <div key={l.path} className={`asset ${current === l.path ? 'selected' : ''}`} onClick={() => apply(l)} title={l.path}>
              <div className="thumb lut-thumb" style={l.thumb ? { backgroundImage: `url("${mediaUrl(l.thumb)}")` } : undefined}>
                {!l.thumb && <Icon name="adjust" size={22} />}
              </div>
              <div className="label">{l.name}.cube</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>('media')
  return (
    <div className="panel">
      <div className="tabs-bar">
        {TABS.map((t) => (
          <button key={t.id} className={`tab-icon ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            <span>{t.label === 'Archivos multimedia' ? 'Multimedia' : t.label}</span>
          </button>
        ))}
      </div>
      {tab === 'media' && <MediaBrowser kinds={['video', 'image']} importLabel="Importar" />}
      {tab === 'audio' && <MediaBrowser kinds={['audio']} importLabel="Importar audio o música" />}
      {tab === 'text' && <TextBrowser />}
      {tab === 'transitions' && <TransitionBrowser />}
      {tab === 'adjust' && <LutBrowser />}
    </div>
  )
}
