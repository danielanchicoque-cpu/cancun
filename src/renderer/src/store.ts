// Estado de la ventana: proyecto abierto, historial, reproducción, selección y vista.
// Todo cambio al proyecto pasa por `dispatch`, que usa las mismas operaciones que el CLI.

import { create } from 'zustand'
import { applyOp, type Op } from '@shared/ops'
import { type Clip, type Id, type Project, US, projectDuration } from '@shared/project'
import { api } from './api'

const HISTORY_LIMIT = 300
const AUTOSAVE_MS = 700

export type SaveState = 'saved' | 'pending' | 'saving' | 'error'
export type Layout = 'default' | 'vertical'
export type SelectMode = 'replace' | 'toggle' | 'add'

interface EditorState {
  project: Project | null
  past: Project[]
  future: Project[]
  /** Clips seleccionados (el último es el principal, el que muestra el inspector). */
  selection: Id[]
  time: number
  playing: boolean
  /** Píxeles por segundo en la línea de tiempo. */
  zoom: number
  save: SaveState
  saveError: string | null
  layout: Layout
  chatOpen: boolean
  /** Clips copiados con Ctrl+C. */
  clipboard: Clip[]
  /** Instante bajo el mouse en la línea de tiempo (vista previa al pasar el cursor). */
  hoverTime: number | null
  /** Vista previa al pasar el cursor activada. */
  skim: boolean

  open(p: Project): void
  close(): void
  dispatch(ops: Op | Op[]): Array<Id | undefined>
  /** Como dispatch, pero reemplaza el último paso del historial (para arrastres en vivo). */
  preview(base: Project, ops: Op | Op[]): void
  undo(): void
  redo(): void
  select(id: Id | Id[] | null, mode?: SelectMode): void
  seek(t: number): void
  setPlaying(v: boolean): void
  setZoom(z: number): void
  setLayout(l: Layout): void
  toggleChat(v?: boolean): void
  copy(): void
  setHover(t: number | null): void
  setSkim(v: boolean): void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

const readLayout = (): Layout => {
  try {
    return localStorage.getItem('cancun.layout') === 'vertical' ? 'vertical' : 'default'
  } catch {
    return 'default'
  }
}

export const useEditor = create<EditorState>((set, get) => {
  async function flush() {
    const p = get().project
    if (!p) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    set({ save: 'saving' })
    try {
      await api.saveProject(p)
      if (get().project === p) set({ save: 'saved', saveError: null })
    } catch (err) {
      set({ save: 'error', saveError: err instanceof Error ? err.message : String(err) })
    }
  }

  function scheduleSave() {
    set({ save: 'pending' })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, AUTOSAVE_MS)
  }

  // Guardar de inmediato si se cierra o se pierde el foco: nunca se pierde trabajo.
  window.addEventListener('beforeunload', () => void flush())
  window.addEventListener('blur', () => {
    if (get().save === 'pending') void flush()
  })

  const alive = (p: Project, ids: Id[]) => {
    const all = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    return ids.filter((id) => all.has(id))
  }

  return {
    project: null,
    past: [],
    future: [],
    selection: [],
    time: 0,
    playing: false,
    zoom: 60,
    save: 'saved',
    saveError: null,
    layout: readLayout(),
    chatOpen: false,
    clipboard: [],
    hoverTime: null,
    skim: (() => {
      try {
        return localStorage.getItem('cancun.skim') !== '0'
      } catch {
        return true
      }
    })(),

    open(p) {
      set({ project: p, past: [], future: [], selection: [], time: 0, playing: false, save: 'saved' })
    },

    close() {
      void flush()
      set({ project: null, past: [], future: [], selection: [], playing: false })
    },

    dispatch(ops) {
      const list = Array.isArray(ops) ? ops : [ops]
      const before = get().project
      if (!before || !list.length) return []
      let p = before
      const created: Array<Id | undefined> = []
      for (const op of list) {
        const r = applyOp(p, op)
        p = r.project
        created.push(r.createdId)
      }
      const past = [...get().past, before].slice(-HISTORY_LIMIT)
      set({ project: p, past, future: [], selection: alive(p, get().selection) })
      scheduleSave()
      return created
    },

    preview(base, ops) {
      const list = Array.isArray(ops) ? ops : [ops]
      let p = base
      for (const op of list) p = applyOp(p, op).project
      const past = get().past
      // El primer paso del gesto guarda la base; los siguientes la reemplazan.
      const nextPast = past[past.length - 1] === base ? past : [...past, base].slice(-HISTORY_LIMIT)
      set({ project: p, past: nextPast, future: [] })
      scheduleSave()
    },

    undo() {
      const { past, project, future } = get()
      if (!past.length || !project) return
      const prev = past[past.length - 1]
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future], selection: alive(prev, get().selection) })
      scheduleSave()
    },

    redo() {
      const { past, project, future } = get()
      if (!future.length || !project) return
      set({ project: future[0], past: [...past, project], future: future.slice(1), selection: alive(future[0], get().selection) })
      scheduleSave()
    },

    select(id, mode = 'replace') {
      const ids = id === null ? [] : Array.isArray(id) ? id : [id]
      const cur = get().selection
      if (mode === 'replace') set({ selection: ids })
      else if (mode === 'add') set({ selection: [...cur.filter((x) => !ids.includes(x)), ...ids] })
      else {
        const next = [...cur]
        for (const x of ids) {
          const i = next.indexOf(x)
          if (i >= 0) next.splice(i, 1)
          else next.push(x)
        }
        set({ selection: next })
      }
    },

    seek(t) {
      const p = get().project
      const end = p ? projectDuration(p) : 0
      set({ time: Math.max(0, Math.min(Math.round(t), Math.max(end, 0))) })
    },

    setPlaying(v) {
      const p = get().project
      if (v && p && get().time >= projectDuration(p) - US / 60) set({ time: 0 })
      set({ playing: v })
    },

    setZoom: (z) => set({ zoom: Math.max(4, Math.min(1200, z)) }),

    setLayout(l) {
      try {
        localStorage.setItem('cancun.layout', l)
      } catch {
        /* sin almacenamiento local, se usa solo en esta sesión */
      }
      set({ layout: l })
    },

    setHover(t) {
      if (get().hoverTime !== t) set({ hoverTime: t })
    },

    setSkim(v) {
      try {
        localStorage.setItem('cancun.skim', v ? '1' : '0')
      } catch {
        /* sin almacenamiento local */
      }
      set({ skim: v, hoverTime: null })
    },

    toggleChat: (v) => set({ chatOpen: v ?? !get().chatOpen }),

    copy() {
      const p = get().project
      if (!p) return
      const ids = new Set(get().selection)
      set({ clipboard: p.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id))).map((c) => structuredClone(c)) })
    }
  }
})

/** El clip principal de la selección (el que se edita en el inspector). */
export const primarySelection = (s: { selection: Id[] }): Id | null => s.selection[s.selection.length - 1] ?? null

export const flushSave = (): void => {
  const s = useEditor.getState()
  if (s.project && s.save !== 'saved') void api.saveProject(s.project)
}
