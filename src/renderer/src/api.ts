// Envoltura tipada del puente expuesto por el preload.

import type { Media, Project } from '@shared/project'

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  duration: number
}

export interface LutEntry {
  name: string
  path: string
  thumb: string | null
}

export interface LoadedLut {
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title: string
  data: Float32Array
}

const c = () => window.cancun

/** URL que el reproductor puede leer para un archivo local. */
export const mediaUrl = (path: string): string => `media://local/${encodeURIComponent(path.replace(/\\/g, '/'))}`

export const api = {
  listProjects: (): Promise<ProjectSummary[]> => c().projects.list(),
  loadProject: (id: string): Promise<Project> => c().projects.load(id),
  saveProject: (p: Project): Promise<void> => c().projects.save(p),
  deleteProject: (id: string): Promise<void> => c().projects.remove(id),

  pickMedia: (): Promise<string[]> => c().media.pick(),
  probe: (paths: string[]): Promise<Media[]> => c().media.probe(paths),
  filmstrip: (m: Media): Promise<string> => c().media.filmstrip(m),
  waveform: (m: Media): Promise<number[]> => c().media.waveform(m),
  pathOf: (f: File): string => c().media.pathOf(f),

  listLuts: (): Promise<LutEntry[]> => c().luts.list(),
  syncLuts: (): Promise<number> => c().luts.sync(),
  importLuts: (): Promise<LutEntry[]> => c().luts.import(),
  loadLut: (path: string): Promise<LoadedLut> => c().luts.load(path),

  pickExport: (name: string, format = 'mp4'): Promise<string | null> => c().exporter.pick(name, format),
  startExport: (p: Project, output: string): Promise<{ output: string; encoder: string }> => c().exporter.start(p, output),
  cancelExport: (): Promise<void> => c().exporter.cancel(),
  onExportProgress: (cb: (p: { fraction: number; fps: number; eta: number }) => void): (() => void) => c().exporter.onProgress(cb),
  reveal: (path: string): Promise<void> => c().reveal(path)
}
