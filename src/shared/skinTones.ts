// Transformaciones de color del retoque de piel. Cada una es una matriz 3×3 + desplazamiento
// (RGB → RGB) ajustada por mínimos cuadrados sobre colores de piel para que la respuesta
// coincida con la de CapCut (medida en sus LUT de retoque, error medio de 1 a 2 %).
// No se copia ningún LUT ni imagen: solo estos números, propios de Cancun.
//
// `m` va por filas de entrada: m[0..2] = aporte del rojo de entrada a (r, g, b) de salida,
// m[3..5] el del verde y m[6..8] el del azul. Así se carga tal cual como mat3 en GLSL.

export interface ColorXform {
  m: [number, number, number, number, number, number, number, number, number]
  t: [number, number, number]
}

/** Blanqueamiento de piel (error medio 1,5 % sobre tonos de piel). */
export const WHITEN: ColorXform = {
  m: [0.8696, 0.0912, 0.0738, 0.0846, 0.9692, 0.3251, -0.1435, -0.2465, 0.5198],
  t: [0.1565, 0.1471, 0.0673]
}

/** Aclarado de manchas oscuras que acompaña al suavizado (error medio 0,8 %). */
export const BRIGHTEN: ColorXform = {
  m: [0.9616, 0.1353, 0.1761, 0, 0.8633, 0, -0.0832, -0.1024, 0.7591],
  t: [0.0966, 0.0777, 0.0403]
}

export interface SkinTone extends ColorXform {
  /** Color de la muestra: cómo queda una piel media con este tono al 100 %. */
  swatch: string
}

/** Tonos de piel, de claro a oscuro (los mismos nueve que ofrece CapCut). */
export const SKIN_TONES: SkinTone[] = [
  { swatch: '#ddb39a', m: [1.0687, 0.0836, 0.1089, -0.0812, 0.9301, 0.0827, -0.1054, 0.004, 0.851], t: [0.1035, 0.0378, 0.02] },
  { swatch: '#d7ae9a', m: [0.8958, 0.0456, 0.0368, 0.0742, 1.0475, 0.3918, -0.1698, -0.2303, 0.4721], t: [0.1625, 0.1116, 0.074] },
  { swatch: '#d2a687', m: [1.0718, 0.1078, 0.0931, -0.0071, 1.015, -0.003, -0.1019, -0.1387, 0.9523], t: [0.0219, 0.0096, -0.0278] },
  { swatch: '#c79473', m: [1.0686, 0.3059, 0.1044, 0.1094, 0.3729, -0.2102, -0.0879, 0.3009, 0.9192], t: [-0.0838, -0.0461, 0.0056] },
  { swatch: '#cc9273', m: [0.9618, -0.1837, -0.2354, 0.0369, 1.2266, 0.287, 0.0641, -0.0744, 0.7699], t: [-0.0269, -0.0074, 0.0459] },
  { swatch: '#bd896d', m: [0.6483, -0.1861, -0.383, 0.3501, 1.194, 0.6096, 0.0503, 0.1106, 0.7226], t: [-0.0516, -0.1101, -0.0194] },
  { swatch: '#bf8360', m: [0.6024, -0.3402, -0.2712, 0.4681, 1.4043, 0.1269, 0.0783, -0.0088, 0.9938], t: [-0.0604, -0.0577, 0.0261] },
  { swatch: '#bc8163', m: [1.0021, 0.3763, 0.2515, 0.3677, 0.4676, -0.2312, -0.335, 0.0863, 0.7312], t: [-0.116, -0.0949, -0.0358] },
  { swatch: '#ad7b64', m: [1.0311, 0.3182, 0.1743, 0.2138, 0.4431, -0.0701, -0.1155, 0.1917, 0.6898], t: [-0.1886, -0.1035, -0.0353] }
]

export const applyXform = (x: ColorXform, [r, g, b]: [number, number, number]): [number, number, number] => [
  r * x.m[0] + g * x.m[3] + b * x.m[6] + x.t[0],
  r * x.m[1] + g * x.m[4] + b * x.m[7] + x.t[1],
  r * x.m[2] + g * x.m[5] + b * x.m[8] + x.t[2]
]

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * Transformación para un tono guardado en el proyecto. Las muestras viejas (de versiones
 * anteriores de Cancun) se llevan a la más parecida de las nuevas.
 */
export function skinToneXform(hex: string): ColorXform {
  const exact = SKIN_TONES.find((t) => t.swatch.toLowerCase() === hex.toLowerCase())
  if (exact) return exact
  const c = hexRgb(hex)
  let best = SKIN_TONES[0]
  let bestD = Infinity
  for (const t of SKIN_TONES) {
    const s = hexRgb(t.swatch)
    const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}
