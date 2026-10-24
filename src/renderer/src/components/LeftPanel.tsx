import { useEffect, useMemo, useRef, useState } from 'react'
import type { Media } from '@shared/project'
import { useEditor } from '../store'
import { api, mediaUrl, type LutEntry, type SoundEntry } from '../api'
import { useFilmstrip } from '../assets'
import { DEFAULT_TRANSITION_US, addToTimeline, applyTransition, importFiles, pickAndImport, targetClip, toast } from '../actions'
import { shortTime } from '../format'
import { EFFECTS } from '../gl/shaders'
import { THUMB_FRAMES, thumbFrames, thumbStill } from '../gl/thumbnails'
import { TEXT_PRESETS, TRANSITIONS } from './catalog'
import { Icon, type IconName } from './icons'

type Tab = 'media' | 'audio' | 'text' | 'effects' | 'transitions' | 'adjust'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'media', label: 'Multimedia', icon: 'media' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'text', label: 'Texto', icon: 'text' },
  { id: 'effects', label: 'Efectos', icon: 'effects' },
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
    try {
      localStorage.setItem(TUYOS_KEY, JSON.stringify(next))
    } catch {
      /* sin almacenamiento local: vale solo para esta sesión */
    }
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

function useFileDrop() {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      },
      onDragLeave: () => setOver(false),
      onDrop: async (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(false)
        const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean)
        if (paths.length) await importFiles(paths).catch((err) => toast(String(err), true))
      }
    }
  }
}

function MediaBrowser() {
  const media = useEditor((s) => s.project!.media)
  const [section, setSection] = useState<'import' | 'tuyos'>('import')
  const drop = useFileDrop()
  const tuyos = useTuyos()
  const tuyosMedia = useProbed(tuyos.paths).filter((m) => m.kind !== 'audio')
  const list = Object.values(media).filter((m) => m.kind !== 'audio')
  const inProject = new Set(list.map((m) => m.path.toLowerCase()))

  return (
    <div className="left-body">
      <div className="side-nav">
        <button className={section === 'import' ? 'active' : ''} onClick={() => setSection('import')}>Importar</button>
        <button className={section === 'tuyos' ? 'active' : ''} onClick={() => setSection('tuyos')}>Tuyos</button>
      </div>
      <div className="side-content" {...drop.props}>
        {section === 'import' ? (
          <>
            <div className={`drop-zone ${drop.over ? 'over' : ''}`} onClick={() => pickAndImport().catch((err) => toast(String(err), true))}>
              <Icon name="plus" /> Importar
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

/** Un reproductor compartido para escuchar los sonidos antes de usarlos. */
const previewAudio = new Audio()

function SoundRow({ sound, playing, onPlay }: { sound: SoundEntry; playing: boolean; onPlay: () => void }) {
  const add = async () => {
    const [m] = await importFiles([sound.path])
    if (m) addToTimeline(m, { start: useEditor.getState().time })
  }
  return (
    <div
      className={`sound-row ${playing ? 'playing' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-cancun-path', sound.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={add}
      title={sound.path}
    >
      <button className="icon-btn" onClick={onPlay} title={playing ? 'Detener' : 'Escuchar'}>
        <Icon name={playing ? 'stop' : 'play'} size={13} />
      </button>
      <span className="name">{sound.name}</span>
      <button className="icon-btn add-btn" title="Agregar en el cursor" onClick={add}>
        <Icon name="plus" size={13} />
      </button>
    </div>
  )
}

function AudioBrowser() {
  const media = useEditor((s) => s.project!.media)
  const [section, setSection] = useState<'sounds' | 'import' | 'tuyos'>('sounds')
  const [sounds, setSounds] = useState<SoundEntry[] | null>(null)
  const [category, setCategory] = useState<string>('')
  const [query, setQuery] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const drop = useFileDrop()
  const tuyos = useTuyos()
  const tuyosMedia = useProbed(tuyos.paths).filter((m) => m.kind === 'audio')
  const list = Object.values(media).filter((m) => m.kind === 'audio')

  useEffect(() => {
    void api.listSounds().then(setSounds).catch(() => setSounds([]))
    previewAudio.onended = () => setPlaying(null)
    return () => previewAudio.pause()
  }, [])

  const categories = useMemo(() => [...new Set((sounds ?? []).map((s) => s.category.split(' / ')[0]))], [sounds])
  const shown = (sounds ?? []).filter(
    (s) => (!category || s.category.split(' / ')[0] === category) && (!query || `${s.name} ${s.category}`.toLowerCase().includes(query.toLowerCase()))
  )

  const play = (s: SoundEntry) => {
    if (playing === s.path) {
      previewAudio.pause()
      setPlaying(null)
      return
    }
    previewAudio.src = mediaUrl(s.path)
    void previewAudio.play()
    setPlaying(s.path)
  }

  return (
    <div className="left-body">
      <div className="side-nav">
        <button className={section === 'sounds' ? 'active' : ''} onClick={() => setSection('sounds')}>Efectos de sonido</button>
        <button className={section === 'import' ? 'active' : ''} onClick={() => setSection('import')}>Importar</button>
        <button className={section === 'tuyos' ? 'active' : ''} onClick={() => setSection('tuyos')}>Tuyos</button>
      </div>
      <div className="side-content" {...drop.props}>
        {section === 'sounds' && (
          <>
            <div className="search">
              <Icon name="search" size={13} />
              <input placeholder="Buscar sonido" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="chips">
              <button className={!category ? 'active' : ''} onClick={() => setCategory('')}>Todos</button>
              {categories.filter(Boolean).map((c) => (
                <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
            {sounds === null && <div className="empty">Cargando tu biblioteca…</div>}
            {sounds?.length === 0 && <div className="empty">No encontré la carpeta de efectos de sonido.</div>}
            <div className="sound-list">
              {shown.slice(0, 400).map((s) => (
                <SoundRow key={s.path} sound={s} playing={playing === s.path} onPlay={() => play(s)} />
              ))}
            </div>
          </>
        )}
        {section === 'import' && (
          <>
            <div className={`drop-zone ${drop.over ? 'over' : ''}`} onClick={() => pickAndImport().catch((err) => toast(String(err), true))}>
              <Icon name="plus" /> Importar audio o música
              <div className="hint">o arrastra archivos aquí</div>
            </div>
            <div className="asset-grid">
              {list.map((m) => (
                <MediaTile key={m.id} media={m} inProject starred={tuyos.paths.includes(m.path)} onStar={() => tuyos.toggle(m.path)} />
              ))}
            </div>
          </>
        )}
        {section === 'tuyos' && (
          <div className="asset-grid">
            {tuyosMedia.length === 0 && <div className="empty">Marca con ★ los audios que quieras reutilizar.</div>}
            {tuyosMedia.map((m) => (
              <MediaTile key={m.path} media={m} inProject={Boolean(Object.values(media).find((x) => x.path === m.path))} starred onStar={() => tuyos.toggle(m.path)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TextBrowser() {
  const add = (p: (typeof TEXT_PRESETS)[number]) => {
    const s = useEditor.getState()
    const [id] = s.dispatch({ op: 'addText', text: p.text, start: s.time, style: p.style })
    if (id) s.select(id)
  }
  return (
    <div className="side-content">
      <div className="hint" style={{ marginBottom: 8 }}>Clic para agregar en el cursor, o arrástralo a la línea de tiempo.</div>
      <div className="asset-grid">
        {TEXT_PRESETS.map((p) => (
          <div
            key={p.label}
            className="asset"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-cancun-text', JSON.stringify({ text: p.text, style: p.style }))}
            onClick={() => add(p)}
          >
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
                {p.text}
              </span>
            </div>
            <div className="label">{p.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Miniatura real (renderizada con el shader) que se anima al pasar el mouse. */
function AnimatedThumb({ kind, id }: { kind: 'transition' | 'effect'; id: string }) {
  const [frame, setFrame] = useState<string>(() => thumbStill(kind, id))
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const stop = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    setFrame(thumbStill(kind, id))
  }
  useEffect(() => stop, [])
  return (
    <div
      className="thumb"
      style={{ backgroundImage: `url("${frame}")`, backgroundSize: 'cover' }}
      onPointerEnter={() => {
        const frames = thumbFrames(kind, id)
        let i = 0
        timer.current = setInterval(() => setFrame(frames[i++ % THUMB_FRAMES]), 70)
      }}
      onPointerLeave={stop}
    />
  )
}

function TransitionBrowser() {
  const [group, setGroup] = useState('')
  const groups = [...new Set(TRANSITIONS.map((t) => t.group))]
  const apply = (kind: (typeof TRANSITIONS)[number]['kind']) => {
    const p = useEditor.getState().project!
    const clip = targetClip(p)
    if (!clip) return toast('Selecciona un clip de la pista principal (o pon el cursor sobre uno)', true)
    applyTransition(clip.id, { kind, duration: clip.transition?.duration ?? DEFAULT_TRANSITION_US })
  }
  return (
    <div className="side-content">
      <div className="chips">
        <button className={!group ? 'active' : ''} onClick={() => setGroup('')}>Todas</button>
        {groups.map((g) => (
          <button key={g} className={group === g ? 'active' : ''} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      <div className="asset-grid">
        {TRANSITIONS.filter((t) => !group || t.group === group).map((t) => (
          <div
            key={t.kind}
            className="asset"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-cancun-transition', t.kind)}
            onClick={() => apply(t.kind)}
            title="Clic: aplicar al clip seleccionado · Arrastrar: soltar entre dos clips"
          >
            <AnimatedThumb kind="transition" id={t.kind} />
            <div className="label">{t.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EffectBrowser() {
  const add = (id: string) => {
    const s = useEditor.getState()
    const [created] = s.dispatch({ op: 'addEffect', effect: id, start: s.time })
    if (created) s.select(created)
  }
  return (
    <div className="side-content">
      <div className="hint" style={{ marginBottom: 8 }}>Los efectos van en su propia pista y afectan todo lo que tienen debajo.</div>
      <div className="asset-grid">
        {EFFECTS.map((e) => (
          <div
            key={e.id}
            className="asset"
            draggable
            onDragStart={(ev) => ev.dataTransfer.setData('application/x-cancun-effect', e.id)}
            onClick={() => add(e.id)}
          >
            <AnimatedThumb kind="effect" id={e.id} />
            <div className="label">{e.label}</div>
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
    if (!clip) return toast('Selecciona un clip de video o arrastra el LUT encima de uno', true)
    const same = clip.color.lut?.path === l.path
    s.dispatch({ op: 'setLut', clipId: clip.id, lut: same ? null : { path: l.path, name: l.name, intensity: clip.color.lut?.intensity ?? 1 } })
  }

  return (
    <div className="left-body">
      <div className="side-nav">
        <button className="active">LUT</button>
      </div>
      <div className="side-content">
        <div className="inline">
          <button className="btn" onClick={() => api.importLuts().then(refresh).catch((e) => toast(String(e), true))}>
            <Icon name="plus" size={12} /> Importar
          </button>
          <button
            className="btn"
            title="Capa de ajuste en el cursor: afecta todo lo que tiene debajo"
            onClick={() => {
              const s = useEditor.getState()
              const [id] = s.dispatch({ op: 'addAdjust', start: s.time })
              if (id) s.select(id)
            }}
          >
            <Icon name="adjust" size={12} /> Agregar ajuste
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>Arrastra un LUT a la línea de tiempo para crear una capa de ajuste, o haz clic para aplicarlo al clip seleccionado.</div>
        <div className="asset-grid">
          {luts.map((l) => (
            <div
              key={l.path}
              className={`asset ${current === l.path ? 'selected' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/x-cancun-lut', JSON.stringify({ path: l.path, name: l.name }))}
              onClick={() => apply(l)}
              title={`${l.path}\nClic: aplicar al clip seleccionado · Arrastrar: capa de ajuste`}
            >
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
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      {tab === 'media' && <MediaBrowser />}
      {tab === 'audio' && <AudioBrowser />}
      {tab === 'text' && <TextBrowser />}
      {tab === 'effects' && <EffectBrowser />}
      {tab === 'transitions' && <TransitionBrowser />}
      {tab === 'adjust' && <LutBrowser />}
    </div>
  )
}
