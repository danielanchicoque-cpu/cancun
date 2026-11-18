// Biblioteca de LUTs de Cancun (Documentos/Cancun/LUTs). Cada LUT vive en su carpeta con
// el .cube y, si la hay, su miniatura. Se llena de varias fuentes:
//  - los LUT importados en CapCut (Resources/Lut) y en JianyingPro;
//  - los .cube que usan los proyectos de CapCut (también en la carpeta de borradores
//    personalizada que CapCut guarda en su configuración), aunque estén en otra carpeta;
//  - los filtros de CapCut usados en esos proyectos, que son LUT en PNG (se convierten);
//  - lo que el usuario importe a mano: archivos .cube/.png o carpetas enteras.

import { app, nativeImage } from 'electron'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { type CubeLut, cubeFromImage, decodeCubeText, parseCube, serializeCube } from '@shared/cube'

export interface LutEntry {
  name: string
  path: string
  thumb: string | null
}

const LOCAL = process.env.LOCALAPPDATA ?? ''
const CAPCUT_DATA = join(LOCAL, 'CapCut', 'User Data')
const LUT_DIRS = [join(CAPCUT_DATA, 'Resources', 'Lut'), join(LOCAL, 'JianyingPro', 'User Data', 'Resources', 'Lut')]
const IMAGE = /\.(jpe?g|png|webp)$/i

export const lutsRoot = (): string => join(app.getPath('documents'), 'Cancun', 'LUTs')

/** Nombre válido como carpeta de Windows. */
const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80) || 'LUT'

const exists = (name: string) => existsSync(join(lutsRoot(), safeName(name), `${safeName(name)}.cube`))

async function saveLut(name: string, cubeText: string, thumb: string | null): Promise<LutEntry> {
  const n = safeName(name)
  const dir = join(lutsRoot(), n)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, `${n}.cube`)
  await writeFile(dest, cubeText, 'utf8')
  let destThumb: string | null = null
  if (thumb && existsSync(thumb)) {
    destThumb = join(dir, `${n}${extname(thumb)}`)
    await copyFile(thumb, destThumb)
  }
  return { name: n, path: dest, thumb: destThumb }
}

/** Lee un .cube validándolo; lo reescribe en UTF-8 limpio (algunos vienen en UTF-16). */
async function readCube(path: string): Promise<string> {
  const text = decodeCubeText(await readFile(path))
  parseCube(text)
  return text
}

/** Convierte un LUT en imagen (PNG de filtro) a texto .cube, o null si no tiene forma de LUT. */
function imageLut(path: string, title: string): string | null {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  // toBitmap entrega BGRA en Windows.
  const lut = cubeFromImage(new Uint8Array(img.toBitmap()), width, height, 'bgra', title)
  return lut ? serializeCube(lut, title) : null
}

async function importFile(path: string, name = basename(path, extname(path)), thumb: string | null = null): Promise<LutEntry | null> {
  const ext = extname(path).toLowerCase()
  if (ext === '.cube') return saveLut(name, await readCube(path), thumb)
  if (ext === '.png') {
    const text = imageLut(path, name)
    return text ? saveLut(name, text, thumb) : null
  }
  return null
}

/** Busca dentro de una carpeta de filtro de CapCut la imagen que es el LUT. */
async function findLutImage(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4 || !existsSync(dir)) return null
  let best: string | null = null
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      best ??= await findLutImage(p, depth + 1)
    } else if (/^(filter|lut|lookup)[^/\\]*\.png$/i.test(e.name) && !/skin|bg|mask/i.test(e.name)) {
      return p
    }
  }
  return best
}

interface DraftRef {
  name: string
  cube?: string
  filterDir?: string
}

/** Recorre el JSON de un borrador buscando LUTs (.cube) y filtros con su nombre. */
function collectRefs(node: unknown, out: DraftRef[]) {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const o = node as Record<string, unknown>
  const path = typeof o.path === 'string' ? o.path : ''
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ''
  if (path.toLowerCase().endsWith('.cube')) out.push({ name: name || basename(path, extname(path)), cube: path })
  else if (o.type === 'filter' && path && name) out.push({ name, filterDir: path })
  for (const v of Object.values(o)) if (v && typeof v === 'object') collectRefs(v, out)
}

/** Carpetas de borradores de CapCut: la de siempre y la personalizada de su configuración. */
async function draftRoots(): Promise<string[]> {
  const roots = [join(CAPCUT_DATA, 'Projects', 'com.lveditor.draft')]
  try {
    const cfg = await readFile(join(CAPCUT_DATA, 'Config', 'globalSetting'), 'utf8')
    const m = /currentCustomDraftPath=(.+)/.exec(cfg)
    if (m) roots.push(m[1].trim().replace(/\\\\/g, '\\'))
  } catch {
    // Sin configuración: solo la carpeta por defecto.
  }
  return [...new Set(roots)].filter((r) => existsSync(r))
}

async function draftRefs(): Promise<DraftRef[]> {
  const refs: DraftRef[] = []
  for (const root of await draftRoots()) {
    for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      const file = join(root, d.name, 'draft_content.json')
      try {
        if ((await stat(file)).size > 64 * 1024 * 1024) continue
        collectRefs(JSON.parse(await readFile(file, 'utf8')), refs)
      } catch {
        // Borrador cifrado o a medio guardar: se salta.
      }
    }
  }
  return refs
}

/**
 * Trae a la biblioteca los LUT de CapCut que aún no estén. Devuelve cuántos importó.
 * Antes solo miraba Resources/Lut, que en muchos equipos está vacío: CapCut guarda la
 * ruta original del .cube en el proyecto y los filtros como PNG.
 */
export async function syncFromCapCut(): Promise<number> {
  let imported = 0
  for (const root of LUT_DIRS) {
    if (!existsSync(root)) continue
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const src = join(root, entry.name)
      const files = await readdir(src)
      const cube = files.find((f) => f.toLowerCase().endsWith('.cube'))
      if (!cube) continue
      const name = basename(cube, extname(cube))
      if (exists(name)) continue
      const thumb = files.find((f) => IMAGE.test(f))
      try {
        await saveLut(name, await readCube(join(src, cube)), thumb ? join(src, thumb) : null)
        imported++
      } catch (err) {
        console.warn('LUT de CapCut inválido', join(src, cube), err)
      }
    }
  }
  for (const ref of await draftRefs()) {
    if (exists(ref.name)) continue
    try {
      if (ref.cube && existsSync(ref.cube)) {
        await saveLut(ref.name, await readCube(ref.cube), null)
        imported++
      } else if (ref.filterDir) {
        const img = await findLutImage(ref.filterDir)
        const text = img ? imageLut(img, ref.name) : null
        if (text) {
          await saveLut(ref.name, text, null)
          imported++
        }
      }
    } catch (err) {
      console.warn('LUT de un proyecto de CapCut', ref, err)
    }
  }
  return imported
}

/** Importa archivos .cube/.png o carpetas enteras (con subcarpetas). */
export async function importLuts(paths: string[]): Promise<LutEntry[]> {
  const out: LutEntry[] = []
  const errors: string[] = []
  const walk = async (p: string, depth: number) => {
    const info = await stat(p)
    if (info.isDirectory()) {
      if (depth > 6) return
      const files = await readdir(p)
      for (const f of files) await walk(join(p, f), depth + 1)
      return
    }
    const ext = extname(p).toLowerCase()
    if (ext !== '.cube' && ext !== '.png') return
    // Miniatura con el mismo nombre al lado del .cube (como en CapCut).
    const base = p.slice(0, -ext.length)
    const thumb = ext === '.cube' ? ['.jpg', '.jpeg', '.png', '.webp'].map((e) => base + e).find((t) => existsSync(t)) ?? null : null
    try {
      const entry = await importFile(p, basename(p, ext), thumb)
      if (entry) out.push(entry)
      else if (depth === 0) errors.push(`${basename(p)}: no es un LUT`)
    } catch (err) {
      // Dentro de una carpeta se saltan los que no sirven; un archivo elegido a mano avisa.
      if (depth === 0) errors.push(`${basename(p)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const p of paths) await walk(p, 0)
  if (!out.length && errors.length) throw new Error(errors.join('\n'))
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
    const thumb = files.find((f) => IMAGE.test(f))
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
    lut = parseCube(decodeCubeText(await readFile(path)))
    cache.set(path, lut)
  }
  return lut
}
