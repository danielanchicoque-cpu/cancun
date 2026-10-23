import { useEffect, useState } from 'react'
import { autoBitrate, projectDuration } from '@shared/project'
import { useEditor } from '../store'
import { api } from '../api'
import { flushSave } from '../store'

const RESOLUTIONS = [480, 720, 1080, 1440, 2160]

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project!)
  const ex = project.export
  const [output, setOutput] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ fraction: number; speed: string } | null>(null)
  const [result, setResult] = useState<{ output: string; encoder: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [customBitrate, setCustomBitrate] = useState(ex.bitrate !== null)
  const short = Math.min(project.canvas.width, project.canvas.height)
  const [res, setRes] = useState(RESOLUTIONS.includes(short) ? short : 1080)
  const scale = res / short
  const width = Math.round((project.canvas.width * scale) / 2) * 2
  const height = Math.round((project.canvas.height * scale) / 2) * 2
  const recommended = autoBitrate(width, height, ex.fps)
  const setExport = (patch: Partial<typeof ex>) => useEditor.getState().dispatch({ op: 'setExport', patch })

  useEffect(() => api.onExportProgress(setProgress), [])
  useEffect(() => {
    if (ex.width !== width || ex.height !== height) setExport({ width, height })
  }, [width, height])

  const running = progress !== null && !result && !error
  const empty = projectDuration(project) === 0

  async function start() {
    const path = output ?? (await api.pickExport(project.name))
    if (!path) return
    setOutput(path)
    setError(null)
    setResult(null)
    setProgress({ fraction: 0, speed: '' })
    flushSave()
    try {
      setResult(await api.startExport(useEditor.getState().project!, path))
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal">
        <h2>Exportar</h2>
        <div className="grid2">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Exportar a</span>
            <div className="inline">
              <input type="text" readOnly value={output ?? 'Se elige al exportar'} style={{ flex: 1 }} />
              <button className="btn" disabled={running} onClick={async () => setOutput((await api.pickExport(project.name)) ?? output)}>
                Cambiar
              </button>
            </div>
          </div>
          <label className="field">
            <span>Resolución</span>
            <select value={res} disabled={running} onChange={(e) => setRes(Number(e.target.value))}>
              {RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r === 2160 ? '4K' : r === 1440 ? '2K' : `${r}p`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Velocidad de fotogramas</span>
            <select value={ex.fps} disabled={running} onChange={(e) => setExport({ fps: Number(e.target.value) })}>
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Códec</span>
            <select value={ex.codec} disabled={running} onChange={(e) => setExport({ codec: e.target.value as 'h264' | 'hevc' })}>
              <option value="h264">H.264</option>
              <option value="hevc">HEVC (H.265)</option>
            </select>
          </label>
          <label className="field">
            <span>Tasa de bits</span>
            <select
              value={customBitrate ? 'custom' : 'auto'}
              disabled={running}
              onChange={(e) => {
                const custom = e.target.value === 'custom'
                setCustomBitrate(custom)
                setExport({ bitrate: custom ? recommended : null })
              }}
            >
              <option value="auto">Recomendada ({(recommended / 1000).toFixed(0)} Mbps)</option>
              <option value="custom">Personalizada</option>
            </select>
          </label>
          {customBitrate && (
            <label className="field">
              <span>Mbps</span>
              <input
                type="number"
                min={1}
                max={200}
                step={1}
                disabled={running}
                value={Math.round((ex.bitrate ?? recommended) / 1000)}
                onChange={(e) => setExport({ bitrate: Math.max(500, Number(e.target.value) * 1000) })}
              />
            </label>
          )}
          <label className="check" style={{ gridColumn: '1 / -1', marginTop: 6 }}>
            <input type="checkbox" checked={ex.hardware} disabled={running} onChange={(e) => setExport({ hardware: e.target.checked })} />
            Usar la tarjeta gráfica si está disponible (más rápido)
          </label>
        </div>

        {progress && (
          <>
            <div className="progress">
              <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <div className="hint">
              {result
                ? `Listo · codificado con ${result.encoder}`
                : error
                  ? ''
                  : `${Math.round(progress.fraction * 100)}% ${progress.speed ? `· ${progress.speed} tiempo real` : ''}`}
            </div>
          </>
        )}
        {error && <div className="hint" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', userSelect: 'text' }}>{error}</div>}

        <div className="actions">
          {result ? (
            <>
              <button className="btn" onClick={() => api.reveal(result.output)}>Abrir carpeta</button>
              <button className="btn primary" onClick={onClose}>Cerrar</button>
            </>
          ) : running ? (
            <button className="btn" onClick={() => api.cancelExport()}>Cancelar</button>
          ) : (
            <>
              <button className="btn ghost" onClick={onClose}>Cancelar</button>
              <button className="btn primary" disabled={empty} onClick={start}>Exportar</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
