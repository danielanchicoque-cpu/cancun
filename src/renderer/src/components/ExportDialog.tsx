import { useEffect, useState } from 'react'
import { US, autoBitrate, projectDuration } from '@shared/project'
import { exportSize } from '@shared/exportGraph'
import { flushSave, useEditor } from '../store'
import { api, type ExportProgress } from '../api'
import { getPlayer } from './Preview'
import { Icon } from './icons'

const RESOLUTIONS = [
  { value: 480, label: '480P' },
  { value: 720, label: '720P' },
  { value: 1080, label: '1080P' },
  { value: 1440, label: '2K' },
  { value: 2160, label: '4K' }
]

type BitrateMode = 'low' | 'recommended' | 'high' | 'custom'
const BITRATE_FACTOR: Record<Exclude<BitrateMode, 'custom'>, number> = { low: 0.5, recommended: 1, high: 2 }

const fmtSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`)
const fmtDur = (us: number) => {
  const s = Math.round(us / US)
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project!)
  const ex = project.export
  const [name, setName] = useState(project.name)
  const [folder, setFolder] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cancun.exportFolder')
    } catch {
      return null
    }
  })
  const [cover, setCover] = useState<string | null>(null)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<{ output: string; encoder: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const short = Math.min(project.canvas.width, project.canvas.height)
  const [res, setRes] = useState(RESOLUTIONS.some((r) => r.value === short) ? short : 1080)
  const [mode, setMode] = useState<BitrateMode>(ex.bitrate === null ? 'recommended' : 'custom')
  const scale = res / short
  const width = Math.round((project.canvas.width * scale) / 2) * 2
  const height = Math.round((project.canvas.height * scale) / 2) * 2
  const recommended = autoBitrate(width, height, ex.fps)
  const setExport = (patch: Partial<typeof ex>) => useEditor.getState().dispatch({ op: 'setExport', patch })
  const kbps = mode === 'custom' ? ex.bitrate ?? recommended : Math.round(recommended * BITRATE_FACTOR[mode])
  const duration = projectDuration(project)
  // Tamaño aproximado: video a la tasa elegida + audio AAC a 320 kbps.
  const bytes = ((kbps + 320) * 1000 * (duration / US)) / 8

  useEffect(() => api.onExportProgress(setProgress), [])
  useEffect(() => {
    void getPlayer()
      ?.frameAt(Math.min(duration, US))
      .then((url) => {
        setCover(url)
        // La portada se toma moviendo el reproductor: se devuelve a donde estaba.
        getPlayer()?.seek(useEditor.getState().time + 1)
        getPlayer()?.seek(useEditor.getState().time)
      })
  }, [])
  useEffect(() => {
    if (ex.width !== width || ex.height !== height) setExport({ width, height })
  }, [width, height])
  useEffect(() => {
    if (mode !== 'custom') setExport({ bitrate: Math.round(recommended * BITRATE_FACTOR[mode]) })
  }, [mode, recommended])

  const running = progress !== null && !result && !error
  const empty = duration === 0
  const real = exportSize(project)

  async function chooseFolder() {
    const path = await api.pickExport(name, ex.format)
    if (!path) return
    const dir = path.replace(/[\\/][^\\/]+$/, '')
    const file = path.slice(dir.length + 1).replace(/\.(mp4|mov)$/i, '')
    setFolder(dir)
    setName(file)
    try {
      localStorage.setItem('cancun.exportFolder', dir)
    } catch {
      /* sin almacenamiento local */
    }
  }

  async function start() {
    let dir = folder
    if (!dir) {
      const path = await api.pickExport(name, ex.format)
      if (!path) return
      dir = path.replace(/[\\/][^\\/]+$/, '')
      setFolder(dir)
    }
    const output = `${dir}\\${name || 'Cancun'}.${ex.format}`
    setError(null)
    setResult(null)
    setProgress({ fraction: 0, fps: 0, eta: 0 })
    flushSave()
    try {
      setResult(await api.startExport(useEditor.getState().project!, output))
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal export-modal">
        <div className="modal-title">Exportar · {project.name}</div>
        <div className="export-body">
          <div className="export-cover">{cover ? <img src={cover} alt="" /> : <div className="cover-empty" />}</div>
          <div className="export-form">
            <div className="form-row">
              <span>Nombre</span>
              <input type="text" value={name} disabled={running} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-row">
              <span>Exportar a</span>
              <div className="inline" style={{ flex: 1 }}>
                <input type="text" readOnly value={folder ?? 'Elige una carpeta'} style={{ flex: 1 }} title={folder ?? ''} />
                <button className="icon-btn" disabled={running} onClick={chooseFolder} title="Cambiar carpeta">
                  <Icon name="folder" />
                </button>
              </div>
            </div>
            <div className="section-head">
              <Icon name="media" size={14} /> Video
            </div>
            <div className="form-row">
              <span>Resolución</span>
              <select value={res} disabled={running} onChange={(e) => setRes(Number(e.target.value))}>
                {RESOLUTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <span>Tasa de bits</span>
              <select value={mode} disabled={running} onChange={(e) => setMode(e.target.value as BitrateMode)}>
                <option value="low">Más baja</option>
                <option value="recommended">Recomendada</option>
                <option value="high">Más alta</option>
                <option value="custom">Personalizada</option>
              </select>
            </div>
            {mode === 'custom' && (
              <div className="form-row">
                <span />
                <div className="inline">
                  <input
                    type="number"
                    min={300}
                    max={400000}
                    step={100}
                    disabled={running}
                    value={ex.bitrate ?? recommended}
                    onChange={(e) => setExport({ bitrate: Math.max(300, Math.min(400000, Math.round(Number(e.target.value) || 0))) })}
                    style={{ width: 110 }}
                  />
                  <span className="unit">Kbps</span>
                </div>
              </div>
            )}
            <div className="form-row">
              <span />
              <div className="inline">
                <label className="check"><input type="radio" checked={ex.rateControl === 'cbr'} disabled={running} onChange={() => setExport({ rateControl: 'cbr' })} />CBR (tasa de bits estática)</label>
                <label className="check"><input type="radio" checked={ex.rateControl === 'vbr'} disabled={running} onChange={() => setExport({ rateControl: 'vbr' })} />VBR (tasa de bits variable)</label>
              </div>
            </div>
            <div className="form-row">
              <span>Códec</span>
              <select value={ex.codec} disabled={running} onChange={(e) => setExport({ codec: e.target.value as 'h264' | 'hevc' })}>
                <option value="h264">H.264</option>
                <option value="hevc">HEVC</option>
              </select>
            </div>
            <div className="form-row">
              <span>Formato</span>
              <select value={ex.format} disabled={running} onChange={(e) => setExport({ format: e.target.value as 'mp4' | 'mov' })}>
                <option value="mp4">mp4</option>
                <option value="mov">mov</option>
              </select>
            </div>
            <div className="form-row">
              <span>Cuadros por segundo</span>
              <select value={ex.fps} disabled={running} onChange={(e) => setExport({ fps: Number(e.target.value) })}>
                {[24, 25, 30, 50, 60].map((f) => (
                  <option key={f} value={f}>
                    {f}fps
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <span>Tarjeta gráfica</span>
              <label className="check"><input type="checkbox" checked={ex.hardware} disabled={running} onChange={(e) => setExport({ hardware: e.target.checked })} />Codificar con la GPU (NVENC) si está disponible</label>
            </div>
            <div className="section-head">
              <Icon name="audio" size={14} /> Audio
            </div>
            <div className="form-row">
              <span>Formato</span>
              <select disabled value="aac">
                <option value="aac">AAC 320 kbps</option>
              </select>
            </div>
          </div>
        </div>

        {progress && (
          <div className="export-progress">
            <div className="progress">
              <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <div className="hint">
              {result
                ? `Listo · ${real.width}×${real.height} · codificado con ${result.encoder}`
                : error
                  ? ''
                  : `${Math.round(progress.fraction * 100)}% · ${progress.fps ? `${progress.fps.toFixed(0)} cuadros/s · quedan ~${Math.ceil(progress.eta)} s` : 'preparando…'}`}
            </div>
          </div>
        )}
        {error && <div className="hint error-box">{error}</div>}

        <div className="modal-footer">
          <span className="hint">
            <Icon name="media" size={12} /> Duración: {fmtDur(duration)} | Tamaño: alrededor de {fmtSize(bytes)}
          </span>
          <span className="spacer" />
          {result ? (
            <>
              <button className="btn" onClick={() => api.reveal(result.output)}>Abrir carpeta</button>
              <button className="btn primary" onClick={onClose}>Cerrar</button>
            </>
          ) : running ? (
            <button className="btn" onClick={() => api.cancelExport()}>Cancelar</button>
          ) : (
            <>
              <button className="btn primary" disabled={empty || !name} onClick={start}>Exportar</button>
              <button className="btn" onClick={onClose}>Cancelar</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
