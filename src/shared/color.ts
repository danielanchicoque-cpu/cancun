// Todo el ajuste de color de un clip (LUT con intensidad + exposición, contraste,
// brillo, temperatura, tono, luces, sombras y saturación) es una función color→color,
// así que se "hornea" en un solo LUT 3D. La vista previa lo sube a la GPU y la
// exportación se lo pasa a ffmpeg (lut3d): ambos ven exactamente la misma función.

import { type CubeLut, sampleCube } from './cube.ts'
import type { Adjust } from './project.ts'

export const BAKE_SIZE = 33

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function isNeutral(a: Adjust): boolean {
  return (
    !a.brightness && !a.contrast && !a.saturation && !a.exposure && !a.temperature && !a.tint && !a.highlights && !a.shadows
  )
}

export function gradePixel(
  rgb: [number, number, number],
  a: Adjust,
  lut: CubeLut | null,
  intensity: number
): [number, number, number] {
  let [r, g, b] = rgb

  if (lut && intensity > 0) {
    const [lr, lg, lb] = sampleCube(lut, r, g, b)
    r += (lr - r) * intensity
    g += (lg - g) * intensity
    b += (lb - b) * intensity
  }

  if (a.exposure) {
    // En luz lineal, como una cámara: ±1 = ±2 pasos.
    const k = Math.pow(2, a.exposure * 2)
    r = Math.pow(Math.pow(clamp01(r), 2.2) * k, 1 / 2.2)
    g = Math.pow(Math.pow(clamp01(g), 2.2) * k, 1 / 2.2)
    b = Math.pow(Math.pow(clamp01(b), 2.2) * k, 1 / 2.2)
  }

  if (a.temperature || a.tint) {
    r *= 1 + 0.15 * a.temperature
    b *= 1 - 0.15 * a.temperature
    g *= 1 - 0.1 * a.tint
  }

  if (a.contrast) {
    const k = 1 + a.contrast * (a.contrast > 0 ? 0.6 : 0.5)
    r = (r - 0.5) * k + 0.5
    g = (g - 0.5) * k + 0.5
    b = (b - 0.5) * k + 0.5
  }

  if (a.brightness) {
    // Curva gamma: sube los medios sin quemar los blancos ni lavar los negros.
    const gamma = 1 / (1 + a.brightness * 0.6)
    r = Math.pow(clamp01(r), gamma)
    g = Math.pow(clamp01(g), gamma)
    b = Math.pow(clamp01(b), gamma)
  }

  if (a.highlights || a.shadows) {
    const y = clamp01(luma(r, g, b))
    const d = a.shadows * 0.3 * (1 - y) * (1 - y) + a.highlights * 0.3 * y * y
    r += d
    g += d
    b += d
  }

  if (a.saturation) {
    const y = luma(r, g, b)
    const k = 1 + a.saturation
    r = y + (r - y) * k
    g = y + (g - y) * k
    b = y + (b - y) * k
  }

  return [clamp01(r), clamp01(g), clamp01(b)]
}

/** LUT 3D horneado (orden .cube: rojo varía más rápido). */
export function bakeGrade(a: Adjust, lut: CubeLut | null, intensity: number, size = BAKE_SIZE): Float32Array {
  const data = new Float32Array(size * size * size * 3)
  const s = size - 1
  let n = 0
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = gradePixel([ri / s, gi / s, bi / s], a, lut, intensity)
        data[n++] = r
        data[n++] = g
        data[n++] = b
      }
  return data
}

export function toCubeText(data: Float32Array, size = BAKE_SIZE): string {
  const lines = [`TITLE "Cancun"`, `LUT_3D_SIZE ${size}`]
  for (let i = 0; i < data.length; i += 3) {
    lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`)
  }
  return lines.join('\n') + '\n'
}
