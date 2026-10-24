// Guardado de proyectos en disco: escritura atómica, copias de respaldo rotativas
// y un índice para la pantalla de inicio.

import { app } from 'electron'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/project'

const BACKUP_EVERY_MS = 2 * 60 * 1000
const BACKUPS_KEPT = 20

export const projectsRoot = (): string => join(app.getPath('documents'), 'Cancun', 'Proyectos')

export const projectDir = (id: string): string => join(projectsRoot(), id)
export const projectFile = (id: string): string => join(projectDir(id), 'project.json')

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  duration: number
  /** Ruta de la portada (cuadro del proyecto), si ya se guardó una. */
  cover?: string
  /** Cambia cuando la portada cambia (para no ver una vieja en caché). */
  coverVersion?: number
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

const lastBackup = new Map<string, number>()

export async function saveProject(project: Project): Promise<void> {
  const dir = projectDir(project.id)
  await mkdir(join(dir, 'backups'), { recursive: true })
  const file = projectFile(project.id)
  await writeAtomic(file, JSON.stringify(project))

  const now = Date.now()
  if (now - (lastBackup.get(project.id) ?? 0) >= BACKUP_EVERY_MS) {
    lastBackup.set(project.id, now)
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    await copyFile(file, join(dir, 'backups', `${stamp}.json`))
    const backups = (await readdir(join(dir, 'backups'))).sort()
    for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
      await rm(join(dir, 'backups', old), { force: true })
    }
  }
}

export async function loadProject(id: string): Promise<Project> {
  const file = projectFile(id)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Project
  } catch (err) {
    // Si el archivo principal quedó dañado, se recupera el respaldo más reciente.
    const backups = existsSync(join(projectDir(id), 'backups'))
      ? (await readdir(join(projectDir(id), 'backups'))).sort().reverse()
      : []
    for (const b of backups) {
      try {
        return JSON.parse(await readFile(join(projectDir(id), 'backups', b), 'utf8')) as Project
      } catch {
        continue
      }
    }
    throw err
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsRoot()
  if (!existsSync(root)) return []
  const out: ProjectSummary[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const p = JSON.parse(await readFile(projectFile(entry.name), 'utf8')) as Project
      let duration = 0
      for (const t of p.tracks) for (const c of t.clips) duration = Math.max(duration, c.start + c.duration)
      const cover = join(projectDir(entry.name), 'cover.jpg')
      const coverStat = existsSync(cover) ? await stat(cover) : null
      out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, duration, cover: coverStat ? cover : undefined, coverVersion: coverStat?.mtimeMs })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function deleteProject(id: string): Promise<void> {
  const dir = projectDir(id)
  if ((await stat(dir)).isDirectory()) await rm(dir, { recursive: true, force: true })
}

/** Guarda la portada del proyecto (JPEG en data URL) junto a project.json. */
export async function saveCover(id: string, dataUrl: string): Promise<void> {
  const dir = projectDir(id)
  if (!existsSync(dir)) return
  await writeFile(join(dir, 'cover.jpg'), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
}
