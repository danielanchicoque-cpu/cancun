// Lector de archivos .cube (formato de Adobe/Resolve que también usa CapCut).

export interface CubeLut {
  title: string
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** RGB intercalado, rojo varía más rápido (orden estándar .cube), size³·3 valores. */
  data: Float32Array
}

export class CubeError extends Error {}

const SHAPER_GRID = 33

/** Texto de un .cube desde sus bytes: acepta UTF-8 con o sin BOM y UTF-16 (Resolve/Windows). */
export function decodeCubeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
}

export function parseCube(text: string): CubeLut {
  text = text.replace(/^\uFEFF/, '')
  let title = ''
  let size3 = 0
  let size1 = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const rows: number[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const first = line.charCodeAt(0)
    const numeric = (first >= 48 && first <= 57) || first === 45 || first === 46 || first === 43
    if (numeric) {
      // Algunos programas escriben comentarios al final de la línea, separan con comas o
      // usan coma decimal ("0,5 0,25 1" — solo si hay espacios y ningún punto).
      const cleaned = line.replace(/#.*/, '').trim()
      const decimalComma = /\s/.test(cleaned) && !cleaned.includes('.')
      const parts = (decimalComma ? cleaned.replace(/,/g, '.') : cleaned).split(/[\s,;]+/)
      if (parts.length < 3) throw new CubeError(`Línea inválida: ${line}`)
      rows.push(Number(parts[0]), Number(parts[1]), Number(parts[2]))
      continue
    }
    const [key, ...rest] = line.split(/\s+/)
    switch (key.toUpperCase()) {
      case 'TITLE':
        title = line.slice(5).trim().replace(/^"|"$/g, '')
        break
      case 'LUT_3D_SIZE':
        size3 = Number(rest[0])
        if (!Number.isInteger(size3) || size3 < 2 || size3 > 256) throw new CubeError(`Tamaño inválido: ${rest[0]}`)
        break
      case 'LUT_1D_SIZE':
        size1 = Number(rest[0])
        if (!Number.isInteger(size1) || size1 < 2 || size1 > 65536) throw new CubeError(`Tamaño inválido: ${rest[0]}`)
        break
      case 'DOMAIN_MIN':
        domainMin = rest.slice(0, 3).map(Number) as [number, number, number]
        break
      case 'DOMAIN_MAX':
        domainMax = rest.slice(0, 3).map(Number) as [number, number, number]
        break
      default:
        // LUT_3D_INPUT_RANGE y otras claves de proveedor se ignoran.
        break
    }
  }

  if (!size3 && !size1) throw new CubeError('Falta LUT_3D_SIZE o LUT_1D_SIZE')
  const expected = (size1 + size3 ** 3) * 3
  // Filas de más (líneas sueltas al final) se ignoran; de menos, el archivo está incompleto.
  if (rows.length < expected) throw new CubeError(`Se esperaban ${expected / 3} filas y hay ${rows.length / 3}`)
  rows.length = expected
  if (rows.some((v) => !Number.isFinite(v))) throw new CubeError('Hay valores no numéricos')

  // Los LUT 1D (curvas por canal, p. ej. "QT Gamma Compensation") se hornean en un
  // 3D para que la vista previa y la exportación usen un solo camino.
  const curve = size1 ? Float32Array.from(rows.slice(0, size1 * 3)) : null
  const cube3 = size3 ? Float32Array.from(rows.slice(size1 * 3)) : null
  if (!curve) return { title, size: size3, domainMin, domainMax, data: cube3! }

  const size = size3 || SHAPER_GRID
  const data = new Float32Array(size ** 3 * 3)
  const inner: CubeLut | null = cube3 ? { title, size: size3, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: cube3 } : null
  const applyCurve = (v: number, c: number) => {
    const f = Math.min(1, Math.max(0, v)) * (size1 - 1)
    const i = Math.floor(f)
    const j = Math.min(size1 - 1, i + 1)
    return curve[i * 3 + c] * (1 - (f - i)) + curve[j * 3 + c] * (f - i)
  }
  let n = 0
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        let rgb: [number, number, number] = [applyCurve(r / (size - 1), 0), applyCurve(g / (size - 1), 1), applyCurve(b / (size - 1), 2)]
        if (inner) rgb = sampleCube(inner, rgb[0], rgb[1], rgb[2])
        data[n++] = rgb[0]
        data[n++] = rgb[1]
        data[n++] = rgb[2]
      }
  return { title, size, domainMin, domainMax, data }
}

/** Aplica el LUT a un color (0..1) con interpolación trilineal; sirve para miniaturas y pruebas. */
export function sampleCube(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const s = lut.size - 1
  const norm = (v: number, i: number) =>
    Math.min(1, Math.max(0, (v - lut.domainMin[i]) / (lut.domainMax[i] - lut.domainMin[i]))) * s
  const fr = norm(r, 0)
  const fg = norm(g, 1)
  const fb = norm(b, 2)
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb)
  const r1 = Math.min(s, r0 + 1), g1 = Math.min(s, g0 + 1), b1 = Math.min(s, b0 + 1)
  const dr = fr - r0, dg = fg - g0, db = fb - b0
  const at = (ri: number, gi: number, bi: number, c: number) => lut.data[((bi * lut.size + gi) * lut.size + ri) * 3 + c]
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr
    out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db
  }
  return out
}

/** Escribe un LUT como texto .cube (orden estándar: rojo varía más rápido). */
export function serializeCube(lut: CubeLut, title = lut.title): string {
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`]
  if (lut.domainMin.some((v) => v !== 0) || lut.domainMax.some((v) => v !== 1)) {
    lines.push(`DOMAIN_MIN ${lut.domainMin.join(' ')}`, `DOMAIN_MAX ${lut.domainMax.join(' ')}`)
  }
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`)
  return lines.join('\n') + '\n'
}

/**
 * LUT desde una imagen (los "filtros" de CapCut y de muchas apps son PNG así):
 *  - cuadrícula cuadrada: 512×512 = 64³ en 8×8 cuadros, 64×64 = 16³ en 4×4, etc.;
 *  - tira horizontal: 1024×32 = 32³, 289×17 = 17³ (ancho = alto²).
 * En cada cuadro el rojo crece hacia la derecha, el verde hacia abajo y el azul cambia de
 * cuadro en cuadro (izquierda→derecha, arriba→abajo). `pixels` en RGBA o BGRA.
 */
export function cubeFromImage(pixels: Uint8Array, width: number, height: number, order: 'rgba' | 'bgra' = 'rgba', title = ''): CubeLut | null {
  let size = 0
  let tilesPerRow = 0
  if (width === height * height) {
    size = height
    tilesPerRow = height
  } else if (width === height) {
    const n = Math.round(Math.cbrt(width * height))
    if (n * n * n === width * height && width % n === 0) {
      size = n
      tilesPerRow = width / n
    }
  }
  if (size < 2 || size > 256) return null
  const [ri, bi] = order === 'rgba' ? [0, 2] : [2, 0]
  const data = new Float32Array(size ** 3 * 3)
  let n = 0
  for (let b = 0; b < size; b++) {
    const tx = (b % tilesPerRow) * size
    const ty = Math.floor(b / tilesPerRow) * size
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const p = ((ty + g) * width + tx + r) * 4
        data[n++] = pixels[p + ri] / 255
        data[n++] = pixels[p + 1] / 255
        data[n++] = pixels[p + bi] / 255
      }
  }
  return { title, size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data }
}
