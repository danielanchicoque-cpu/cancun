import { useEffect, useMemo, useRef, useState } from 'react'
import { type Media, US } from '@shared/project'
import { useEditor } from '../store'
import { api, mediaUrl, type LutEntry, type SoundEntry, type SubtitleProgress } from '../api'
import { useFilmstrip } from '../assets'
import { DEFAULT_TRANSITION_US, addToTimeline, autoSubtitles, applyTransition, importFiles, pickAndImport, targetClip, toast } from '../actions'
import { shortTime } from '../format'
import { EFFECTS } from '../gl/shaders'
import { drawThumbFrame, loadSamples, lutThumb, requestStill } from '../gl/thumbnails'

function LutThumb({ lut }: { lut: LutEntry }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    lutThumb(lut.path, api.loadLut)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [lut.path])
  return (
    <div className="thumb lut-thumb" style={url ? { backgroundImage: `url("${url}")` } : undefined}>
      {!url && <Icon name="adjust" size={22} />}
    </div>
  )
}
import { TEXT_PRESETS, TRANSITIONS } from './catalog'
import { Icon, type IconName } from './icons'

type Tab = 'media' | 'audio' | 'text' | 'subs' | 'effects' | 'transitions' | 'adjust'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'media', label: 'Multimedia', icon: 'media' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'text', label: 'Texto', icon: 'text' },
  { id: 'subs', label: 'Subtítulos', icon: 'captions' },
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

/** Color estable por nombre, para la portada de los audios sin carátula. */
function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}

/** Duración y carátula, pedidas solo cuando la fila entra en pantalla. */
function useSoundMeta(path: string, ref: React.RefObject<HTMLElement | null>) {
  const [meta, setMeta] = useState<{ duration: number; cover: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      void api.soundMeta(path).then((m) => alive && setMeta(m))
    })
    if (ref.current) io.observe(ref.current)
    return () => {
      alive = false
      io.disconnect()
    }
  }, [path])
  return meta
}

function SoundCover({ sound, cover, playing }: { sound: SoundEntry; cover: string | null | undefined; playing: boolean }) {
  const hue = hueOf(sound.category + sound.name)
  return (
    <div
      className="sound-cover"
      style={
        cover
          ? { backgroundImage: `url("${mediaUrl(cover)}")` }
          : { background: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 50) % 360} 60% 22%))` }
      }
    >
      {!cover && <Icon name={sound.kind === 'music' ? 'audio' : 'volume'} size={18} />}
      <span className={`play-badge ${playing ? 'on' : ''}`}>
        <Icon name={playing ? 'pause' : 'play'} size={12} />
      </span>
    </div>
  )
}

function SoundRow({
  sound,
  playing,
  starred,
  onPlay,
  onStar
}: {
  sound: SoundEntry
  playing: boolean
  starred: boolean
  onPlay: () => void
  onStar: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const meta = useSoundMeta(sound.path, ref)
  const add = async () => {
    const [m] = await importFiles([sound.path])
    if (m) addToTimeline(m, { start: useEditor.getState().time })
  }
  return (
    <div
      ref={ref}
      className={`sound-row ${playing ? 'playing' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-cancun-path', sound.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onPlay}
      onDoubleClick={add}
      title={sound.path}
    >
      <SoundCover sound={sound} cover={meta?.cover} playing={playing} />
      <div className="sound-text">
        <span className="name">{sound.name}</span>
        <span className="sub">
          {sound.category}
          {meta?.duration ? ` · ${shortTime(meta.duration)}` : ''}
        </span>
      </div>
      <button
        className={`icon-btn star-btn ${starred ? 'on' : ''}`}
        title={starred ? 'Quitar de Tuyos' : 'Guardar en Tuyos'}
        onClick={(e) => {
          e.stopPropagation()
          onStar()
        }}
      >
        <Icon name="star" size={13} />
      </button>
      <button
        className="icon-btn add-btn"
        title="Agregar en el cursor"
        onClick={(e) => {
          e.stopPropagation()
          void add()
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}

/** Barra de reproducción dentro del panel (como la de CapCut), con avance y búsqueda. */
function MiniPlayer({ sound, onClose }: { sound: SoundEntry; onClose: () => void }) {
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setT(previewAudio.currentTime)
      setDur(Number.isFinite(previewAudio.duration) ? previewAudio.duration : 0)
      setPaused(previewAudio.paused)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [sound.path])
  return (
    <div className="mini-player">
      <button className="icon-btn" onClick={() => (previewAudio.paused ? void previewAudio.play() : previewAudio.pause())}>
        <Icon name={paused ? 'play' : 'pause'} size={14} />
      </button>
      <div className="mp-body">
        <div className="mp-name">{sound.name}</div>
        <div className="mp-row">
          <span className="mp-time">{shortTime(t * US)}</span>
          <input
            type="range"
            min={0}
            max={dur || 1}
            step={0.01}
            value={t}
            onChange={(e) => (previewAudio.currentTime = Number(e.target.value))}
          />
          <span className="mp-time">{shortTime(dur * US)}</span>
        </div>
      </div>
      <button className="icon-btn" title="Cerrar" onClick={onClose}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

type AudioSection = 'music' | 'sfx' | 'import' | 'tuyos'

function AudioBrowser() {
  const media = useEditor((s) => s.project!.media)
  const [section, setSection] = useState<AudioSection>(() => (localStorage.getItem('cancun.audioSection') as AudioSection) || 'sfx')
  const [sounds, setSounds] = useState<SoundEntry[] | null>(null)
  const [category, setCategory] = useState<string>('')
  const [query, setQuery] = useState('')
  const [playing, setPlaying] = useState<SoundEntry | null>(null)
  const drop = useFileDrop()
  const tuyos = useTuyos()
  const tuyosMedia = useProbed(tuyos.paths).filter((m) => m.kind === 'audio')
  const list = Object.values(media).filter((m) => m.kind === 'audio')

  useEffect(() => {
    void api.listSounds().then(setSounds).catch(() => setSounds([]))
    // Al terminar, la barra se queda (en pausa) para volver a escucharlo o moverse.
    previewAudio.onended = null
    return () => previewAudio.pause()
  }, [])

  const go = (sec: AudioSection, cat = '') => {
    setSection(sec)
    setCategory(cat)
    localStorage.setItem('cancun.audioSection', sec)
  }
  const ofKind = (k: 'music' | 'sfx') => (sounds ?? []).filter((s) => s.kind === k)
  const categoriesOf = (k: 'music' | 'sfx') => [...new Set(ofKind(k).map((s) => s.category.split(' / ')[0]))].filter(Boolean)
  const library = section === 'music' || section === 'sfx'
  const shown = library
    ? ofKind(section).filter(
        (s) => (!category || s.category.split(' / ')[0] === category) && (!query || `${s.name} ${s.category}`.toLowerCase().includes(query.toLowerCase()))
      )
    : []

  const play = (s: SoundEntry) => {
    if (playing?.path === s.path) {
      if (previewAudio.paused) void previewAudio.play()
      else previewAudio.pause()
      return
    }
    previewAudio.src = mediaUrl(s.path)
    void previewAudio.play()
    setPlaying(s)
  }

  return (
    <div className="left-body">
      <div className="side-nav">
        {(['music', 'sfx'] as const).map((k) => (
          <div key={k} className="nav-group">
            <button className={section === k && !category ? 'active' : ''} onClick={() => go(k)}>
              {k === 'music' ? 'Música' : 'Efectos de sonido'}
            </button>
            {section === k &&
              categoriesOf(k).map((c) => (
                <button key={c} className={`sub ${category === c ? 'active' : ''}`} onClick={() => go(k, c)}>
                  {c}
                </button>
              ))}
          </div>
        ))}
        <button className={section === 'import' ? 'active' : ''} onClick={() => go('import')}>Importar</button>
        <button className={section === 'tuyos' ? 'active' : ''} onClick={() => go('tuyos')}>Tuyos</button>
      </div>
      <div className="side-content audio-content" {...drop.props}>
        {library && (
          <>
            <div className="search">
              <Icon name="search" size={13} />
              <input placeholder={section === 'music' ? 'Buscar canción' : 'Buscar sonido'} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {sounds === null && <div className="empty">Cargando tu biblioteca…</div>}
            {sounds && shown.length === 0 && section === 'music' && (
              <div className="empty">
                Pon tus canciones en la carpeta Música de Cancun y aparecerán aquí.
                <button className="btn" style={{ marginTop: 8 }} onClick={() => void api.openMusicDir()}>
                  <Icon name="folder" size={12} /> Abrir carpeta de música
                </button>
              </div>
            )}
            {sounds && shown.length === 0 && section === 'sfx' && <div className="empty">No hay efectos de sonido en esta categoría.</div>}
            <div className="sound-list">
              {shown.slice(0, 400).map((s) => (
                <SoundRow
                  key={s.path}
                  sound={s}
                  playing={playing?.path === s.path}
                  starred={tuyos.paths.includes(s.path)}
                  onPlay={() => play(s)}
                  onStar={() => tuyos.toggle(s.path)}
                />
              ))}
            </div>
            {section === 'music' && shown.length > 0 && (
              <button className="btn subtle" onClick={() => void api.openMusicDir()}>
                <Icon name="folder" size={12} /> Agregar canciones (carpeta Música de Cancun)
              </button>
            )}
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
        {playing && (
          <MiniPlayer
            sound={playing}
            onClose={() => {
              previewAudio.pause()
              setPlaying(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

const LANGS = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'Inglés' },
  { code: 'pt', label: 'Portugués' },
  { code: 'auto', label: 'Detectar' }
]

function SubtitleBrowser() {
  const [lang, setLang] = useState(() => localStorage.getItem('cancun.subsLang') ?? 'es')
  const [progress, setProgress] = useState<SubtitleProgress | null>(null)
  // ¿Hay algún clip de video/audio elegido? Entonces solo se transcriben esos.
  const selected = useEditor((s) => !!s.project && s.project.tracks.some((t) => t.clips.some((c) => c.type === 'media' && s.selection.includes(c.id))))
  useEffect(() => api.onSubtitleProgress(setProgress), [])
  const run = async () => {
    setProgress({ stage: 'transcribe', fraction: 0, label: 'Preparando…' })
    try {
      const n = await autoSubtitles(lang)
      toast(`${n} subtítulo${n === 1 ? '' : 's'} en la pista "Subtítulos"`)
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err), true)
    } finally {
      setProgress(null)
    }
  }
  return (
    <div className="side-content">
      <div className="subs-panel">
        <div className="subs-title">Subtítulos automáticos</div>
        <div className="hint">
          Reconoce la voz {selected ? 'de los clips seleccionados' : 'de la pista principal'} y crea los subtítulos en una pista propia. Todo se hace en tu PC.
        </div>
        <label className="subs-row">
          Idioma
          <select
            value={lang}
            disabled={!!progress}
            onChange={(e) => {
              setLang(e.target.value)
              localStorage.setItem('cancun.subsLang', e.target.value)
            }}
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary subs-go" disabled={!!progress} onClick={() => void run()}>
          <Icon name="captions" size={14} /> {progress ? 'Generando…' : 'Generar subtítulos'}
        </button>
        {progress && (
          <>
            <div className="progress">
              <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <div className="hint">{progress.label}</div>
          </>
        )}
        <div className="hint" style={{ marginTop: 10 }}>
          La primera vez se descarga el motor de voz (entre 0,6 y 1,2 GB, una sola vez). Si vuelves a generar, se reemplazan los de la pista "Subtítulos". Cada línea se edita como un texto normal.
        </div>
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

/** Miniatura real (renderizada con el shader); se anima en vivo al pasar el mouse. */
function AnimatedThumb({ kind, id }: { kind: 'transition' | 'effect'; id: string }) {
  const [still, setStill] = useState<string | null>(null)
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Solo se genera cuando la miniatura entra en pantalla.
  useEffect(() => {
    const el = ref.current!
    let cancel = () => undefined as void
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      cancel = requestStill(kind, id, setStill)
    })
    io.observe(el)
    return () => {
      io.disconnect()
      cancel()
    }
  }, [kind, id])
  useEffect(() => {
    if (!hover) return
    const ctx = canvasRef.current!.getContext('2d')!
    let raf = 0
    const t0 = performance.now()
    const loop = () => {
      drawThumbFrame(kind, id, ((performance.now() - t0) / 1200) % 1, ctx)
      raf = requestAnimationFrame(loop)
    }
    void loadSamples().then(() => (raf = requestAnimationFrame(loop)))
    return () => cancelAnimationFrame(raf)
  }, [hover, kind, id])
  return (
    <div
      ref={ref}
      className="thumb square"
      style={still ? { backgroundImage: `url("${still}")` } : undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {hover && <canvas ref={canvasRef} width={160} height={160} />}
    </div>
  )
}

// --- Favoritos (por tipo), guardados en este equipo ------------------------------------
function useFavorites(kind: string): [Set<string>, (id: string) => void] {
  const key = `cancun.fav.${kind}`
  const [favs, setFavs] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggle = (id: string) =>
    setFavs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        // Sin almacenamiento: los favoritos duran esta sesión.
      }
      return next
    })
  return [favs, toggle]
}

interface CatalogItem {
  id: string
  label: string
  group: string
}

/**
 * Catálogo estilo CapCut: categorías a la izquierda (con Favoritos), cuadrícula de
 * miniaturas cuadradas a la derecha, estrella para marcar favoritos.
 */
function CatalogBrowser({
  kind,
  items,
  dragType,
  onPick,
  hint
}: {
  kind: 'transition' | 'effect'
  items: CatalogItem[]
  dragType: string
  onPick: (id: string) => void
  hint: string
}) {
  const navKey = `cancun.nav.${kind}`
  const groups = [...new Set(items.map((i) => i.group))]
  const [group, setGroup] = useState(() => localStorage.getItem(navKey) ?? '')
  const [favs, toggleFav] = useFavorites(kind)
  const choose = (g: string) => {
    setGroup(g)
    localStorage.setItem(navKey, g)
  }
  const shown = items.filter((i) => (group === '★' ? favs.has(i.id) : !group || i.group === group))
  return (
    <div className="left-body">
      <div className="side-nav">
        <button className={group === '★' ? 'active' : ''} onClick={() => choose('★')}>
          Favoritos
        </button>
        <button className={!group ? 'active' : ''} onClick={() => choose('')}>
          {kind === 'transition' ? 'Todas' : 'Todos'}
        </button>
        {groups.map((g) => (
          <button key={g} className={group === g ? 'active' : ''} onClick={() => choose(g)}>
            {g}
          </button>
        ))}
      </div>
      <div className="side-content">
        <div className="catalog-title">{group === '★' ? 'Favoritos' : group || (kind === 'transition' ? 'Todas las transiciones' : 'Todos los efectos')}</div>
        {group === '★' && shown.length === 0 && <div className="hint">Marca con la estrella las que más uses y aparecerán aquí.</div>}
        <div className="asset-grid square">
          {shown.map((i) => (
            <div
              key={i.id}
              className="asset"
              draggable
              onDragStart={(e) => e.dataTransfer.setData(dragType, i.id)}
              onClick={() => onPick(i.id)}
              title={hint}
            >
              <AnimatedThumb kind={kind} id={i.id} />
              <button
                className={`fav ${favs.has(i.id) ? 'on' : ''}`}
                title={favs.has(i.id) ? 'Quitar de favoritos' : 'Agregar a favoritos'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFav(i.id)
                }}
              >
                <Icon name="star" size={12} />
              </button>
              <div className="label">{i.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TransitionBrowser() {
  const items = useMemo(() => TRANSITIONS.map((t) => ({ id: t.kind, label: t.label, group: t.group })), [])
  const apply = (kind: string) => {
    const p = useEditor.getState().project!
    const clip = targetClip(p)
    if (!clip) return toast('Selecciona un clip de la pista principal (o pon el cursor sobre uno)', true)
    applyTransition(clip.id, { kind: kind as (typeof TRANSITIONS)[number]['kind'], duration: clip.transition?.duration ?? DEFAULT_TRANSITION_US })
  }
  return <CatalogBrowser kind="transition" items={items} dragType="application/x-cancun-transition" onPick={apply} hint="Clic: aplicar al clip seleccionado · Arrastrar: soltar entre dos clips" />
}

function EffectBrowser() {
  const items = useMemo(() => EFFECTS.map((e) => ({ id: e.id, label: e.label, group: e.group })), [])
  const add = (id: string) => {
    const s = useEditor.getState()
    const [created] = s.dispatch({ op: 'addEffect', effect: id, start: s.time })
    if (created) s.select(created)
  }
  return <CatalogBrowser kind="effect" items={items} dragType="application/x-cancun-effect" onPick={add} hint="Clic: agregar en el cursor · Arrastrar a la línea de tiempo. Afecta todo lo que tiene debajo." />
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
              <LutThumb lut={l} />
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
      {tab === 'subs' && <SubtitleBrowser />}
      {tab === 'effects' && <EffectBrowser />}
      {tab === 'transitions' && <TransitionBrowser />}
      {tab === 'adjust' && <LutBrowser />}
    </div>
  )
}
