// Envoltura tipada del puente expuesto por el preload.

import type { Media, Project } from '@shared/project'
import type { SubtitleJob, TimedText } from '@shared/subtitles'

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  duration: number
  cover?: string
  coverVersion?: number
}

export interface LutEntry {
  name: string
  path: string
  thumb: string | null
}

export interface SoundEntry {
  name: string
  path: string
  category: string
  kind: 'music' | 'sfx'
}

export interface LoadedLut {
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title: string
  data: Float32Array
}

export interface ExportProgress {
  fraction: number
  fps: number
  eta: number
}

export interface ChatEvent {
  type: 'text' | 'tool' | 'done' | 'error' | 'start'
  text?: string
  tool?: string
  error?: string
}

export interface SubtitleProgress {
  stage: 'download-engine' | 'download-model' | 'transcribe'
  fraction: number
  label: string
}

const c = () => window.cancun

/** URL que el reproductor puede leer para un archivo local. */
export const mediaUrl = (path: string): string => `media://local/${encodeURIComponent(path.replace(/\\/g, '/'))}`

export const api = {
  listProjects: (): Promise<ProjectSummary[]> => c().projects.list(),
  loadProject: (id: string): Promise<Project> => c().projects.load(id),
  saveProject: (p: Project): Promise<void> => c().projects.save(p),
  deleteProject: (id: string): Promise<void> => c().projects.remove(id),
  saveCover: (id: string, dataUrl: string): Promise<void> => c().projects.cover(id, dataUrl),

  pickMedia: (): Promise<string[]> => c().media.pick(),
  probe: (paths: string[]): Promise<Media[]> => c().media.probe(paths),
  filmstrip: (m: Media): Promise<{ path: string; frames: number }> => c().media.filmstrip(m),
  waveform: (m: Media): Promise<number[]> => c().media.waveform(m),
  reverse: (path: string): Promise<string> => c().media.reverse(path),
  pathOf: (f: File): string => c().media.pathOf(f),
  listSounds: (): Promise<SoundEntry[]> => c().sounds.list(),
  soundMeta: (path: string): Promise<{ duration: number; cover: string | null }> => c().sounds.meta(path),
  openMusicDir: (): Promise<void> => c().sounds.openMusicDir(),

  listLuts: (): Promise<LutEntry[]> => c().luts.list(),
  syncLuts: (): Promise<number> => c().luts.sync(),
  importLuts: (): Promise<LutEntry[]> => c().luts.import(),
  loadLut: (path: string): Promise<LoadedLut> => c().luts.load(path),

  pickExport: (name: string, format = 'mp4'): Promise<string | null> => c().exporter.pick(name, format),
  startExport: (p: Project, output: string): Promise<{ output: string; encoder: string }> => c().exporter.start(p, output),
  cancelExport: (): Promise<void> => c().exporter.cancel(),
  onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => c().exporter.onProgress(cb),
  reveal: (path: string): Promise<void> => c().reveal(path),

  transcribe: (jobs: SubtitleJob[], lang: string): Promise<TimedText[]> => c().subtitles.run(jobs, lang),
  onSubtitleProgress: (cb: (p: SubtitleProgress) => void): (() => void) => c().subtitles.onProgress(cb as never),

  chatSend: (text: string, context: unknown): Promise<void> => c().chat.send(text, context),
  chatStop: (): Promise<void> => c().chat.stop(),
  claudeStatus: (): Promise<{ installed: boolean; loggedIn: boolean; email?: string }> => c().chat.status(),
  claudeLogin: (): Promise<void> => c().chat.login(),
  chatReset: (): Promise<void> => c().chat.reset(),
  onChatEvent: (cb: (e: ChatEvent) => void): (() => void) => c().chat.onEvent(cb as never)
}
