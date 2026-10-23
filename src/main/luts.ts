// Biblioteca de LUTs de Cancun. La primera vez copia los LUT que Daniel ya tiene
// importados en CapCut (con su miniatura) para que aparezcan igual que allá.

import { app } from 'electron'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parseCube, type CubeLut } from '@shared/cube'

export interface LutEntry {
  name: string
  path: string
  thumb: string | null
}

const CAPCUT_LUTS = join(process.env.LOCALAPPDATA ?? '', 'CapCut', 'User Data', 'Resources', 'Lut')

export const lutsRoot = (): string => join(app.getPath('documents'), 'Cancun', 'LUTs')

async function importFolder(name: string, cube: string, thumb: string | null): Promise<LutEntry> {
  const dir = join(lutsRoot(), name)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, `${name}.cube`)
  await copyFile(cube, dest)
  let destThumb: string | null = null
  if (thumb && existsSync(thumb)) {
    destThumb = join(dir, `${name}${extname(thumb)}`)
    await copyFile(thumb, destThumb)
  }
  return { name, path: dest, thumb: destThumb }
}

/** Copia los LUT de CapCut que aún no estén en la biblioteca. Devuelve cuántos importó. */
export async function syncFromCapCut(): Promise<number> {
  if (!existsSync(CAPCUT_LUTS)) return 0
  let imported = 0
  for (const entry of await readdir(CAPCUT_LUTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const src = join(CAPCUT_LUTS, entry.name)
    const files = await readdir(src)
    const cube = files.find((f) => f.toLowerCase().endsWith('.cube'))
    if (!cube) continue
    const name = basename(cube, extname(cube))
    if (existsSync(join(lutsRoot(), name, `${name}.cube`))) continue
    const thumb = files.find((f) => /\.(jpe?g|png|webp)$/i.test(f))
    await importFolder(name, join(src, cube), thumb ? join(src, thumb) : null)
    imported++
  }
  return imported
}

export async function importLuts(paths: string[]): Promise<LutEntry[]> {
  const out: LutEntry[] = []
  for (const p of paths) {
    parseCube(await readFile(p, 'utf8')) // valida antes de copiar
    out.push(await importFolder(basename(p, extname(p)), p, null))
  }
  return out
}

export async function listLuts(): Promise<LutEntry[]> {
  const root = lutsRoot()
  if (!existsSync(root)) return []
  const out: LutEntry[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const files = await readdir(join(root, entry.name))
    const cube = files.find((f) => f.toLowerCase().endsWith('.cube'))
    if (!cube) continue
    const thumb = files.find((f) => /\.(jpe?g|png|webp)$/i.test(f))
    out.push({
      name: basename(cube, extname(cube)),
      path: join(root, entry.name, cube),
      thumb: thumb ? join(root, entry.name, thumb) : null
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

const cache = new Map<string, CubeLut>()

export async function loadLut(path: string): Promise<CubeLut> {
  let lut = cache.get(path)
  if (!lut) {
    lut = parseCube(await readFile(path, 'utf8'))
    cache.set(path, lut)
  }
  return lut
}
