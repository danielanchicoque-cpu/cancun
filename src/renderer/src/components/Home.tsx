import { useEffect, useState } from 'react'
import { newProject } from '@shared/project'
import { api, type ProjectSummary } from '../api'
import { useEditor } from '../store'
import { shortTime } from '../format'
import { Icon } from './icons'

const PRESETS = [
  { label: '16:9 Horizontal', w: 1920, h: 1080 },
  { label: '9:16 Vertical', w: 1080, h: 1920 },
  { label: '1:1 Cuadrado', w: 1080, h: 1080 },
  { label: '4:5 Retrato', w: 1080, h: 1350 }
]

export function Home() {
  const open = useEditor((s) => s.open)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const refresh = () => api.listProjects().then(setProjects)
  useEffect(() => {
    void refresh()
  }, [])

  async function create(w: number, h: number) {
    const date = new Date()
    const name = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const taken = new Set(projects.map((p) => p.name))
    let unique = name
    for (let i = 1; taken.has(unique); i++) unique = `${name} (${i})`
    const p = newProject(unique, w, h, 30)
    await api.saveProject(p)
    open(p)
  }

  return (
    <div className="home">
      <h1>
        <span>Cancun</span> · Editor de video
      </h1>
      <div className="home-new">
        {PRESETS.map((p) => (
          <div key={p.label} className="new-card" onClick={() => create(p.w, p.h)}>
            <div className="shape" style={{ width: (p.w / Math.max(p.w, p.h)) * 44, height: (p.h / Math.max(p.w, p.h)) * 44 }} />
            <div>
              <Icon name="plus" size={12} /> {p.label}
            </div>
          </div>
        ))}
      </div>
      <div className="section-title">Proyectos</div>
      {projects.length === 0 && <div className="empty">Todavía no hay proyectos. Crea uno arriba.</div>}
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="project-card" onClick={async () => open(await api.loadProject(p.id))}>
            <div className="name">{p.name}</div>
            <div className="meta">
              {shortTime(p.duration)} · {new Date(p.updatedAt).toLocaleString('es-CO')}
            </div>
            <button
              className="icon-btn del"
              title="Eliminar proyecto"
              onClick={async (e) => {
                e.stopPropagation()
                if (confirm(`¿Eliminar "${p.name}"? Esto no se puede deshacer.`)) {
                  await api.deleteProject(p.id)
                  void refresh()
                }
              }}
            >
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
