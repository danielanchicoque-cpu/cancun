// Retoque de rostro y cuerpo: a partir de los puntos que detecta la IA (MediaPipe Face /
// Pose Landmarker) arma una lista corta de deformaciones locales ("licuar") y de zonas
// de tono (ojeras, dientes, cejas…) que el shader aplica en la GPU. Puro: lo usan la
// vista previa, la exportación y las pruebas.

import { RETOUCH_BODY, RETOUCH_FACE, RETOUCH_FEATURES, type Retouch } from './project.ts'

/**
 * Puntos de la malla de 478 que se envían desde el worker, en este orden
 * (x, y normalizados a la imagen, y hacia abajo).
 */
export const FACE_POINTS = [
  10, 152, 234, 454, 172, 397, 468, 473, 33, 133, 362, 263, 159, 145, 386, 374, 1, 129, 358, 6, 61, 291, 0, 17, 13, 14, 105, 334, 132, 361, 168, 4
] as const
const F = Object.fromEntries(FACE_POINTS.map((p, i) => [p, i])) as Record<(typeof FACE_POINTS)[number], number>

/** Puntos de MediaPipe Pose (33). */
const P = { nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lHip: 23, rHip: 24 }

export interface Landmarks {
  /** FACE_POINTS.length × 2 (x, y), o null si no hay cara. */
  face: Float32Array | null
  /** 33 × 3 (x, y, visibilidad), o null si no hay persona. */
  pose: Float32Array | null
}

const anyOn = (r: Retouch, keys: readonly (keyof Retouch)[]) => keys.some((k) => Math.abs(r[k] as number) > 0.001)

/** ¿Hace falta detectar la cara? */
export function needsFace(r: Retouch): boolean {
  return (r.face && anyOn(r, RETOUCH_FACE)) || (r.features && anyOn(r, RETOUCH_FEATURES)) || (r.skin && (r.darkCircles > 0 || r.smileLines > 0))
}

/** ¿Hace falta detectar el cuerpo? */
export function needsPose(r: Retouch): boolean {
  return r.body && anyOn(r, RETOUCH_BODY)
}

/** ¿Hace falta la máscara de piel? */
export function needsSkin(r: Retouch): boolean {
  return r.skin && (r.smooth > 0 || r.whiten > 0 || r.removeBlemishes > 0 || r.evenTone > 0 || (r.skinTone !== null && r.skinToneAmount > 0))
}

export const MAX_WARPS = 24
export const MAX_TONES = 10

/** Tipos de deformación y de zona de tono (los mismos números que en el shader). */
export const WARP_SCALE = 0
export const WARP_MOVE = 1
export const TONE_DARK_CIRCLE = 1
export const TONE_SMILE_LINE = 2
export const TONE_TEETH = 3
export const TONE_EYE_BRIGHT = 4
export const TONE_BROW = 5

export interface RetouchOps {
  /** Por deformación: centro x, y, radio x, radio y (en uv con x multiplicada por el aspecto). */
  warpA: Float32Array
  /** Por deformación: tipo, a, b, 0. Escala: a/b = aumento en x/y. Mover: a/b = desplazamiento. */
  warpB: Float32Array
  warpN: number
  /** Por zona: centro x, y, radio x, radio y. */
  toneA: Float32Array
  /** Por zona: tipo, cantidad, extra x, extra y. */
  toneB: Float32Array
  toneN: number
}

type V = [number, number]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k]
const mid = (a: V, b: V): V => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const len = (a: V) => Math.hypot(a[0], a[1])
const dist = (a: V, b: V) => len(sub(a, b))
const norm = (a: V): V => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}

/**
 * Deformaciones y zonas para un cuadro. \`aspect\` = ancho / alto de la fuente. Las
 * coordenadas de salida son uv de la textura (y hacia arriba) con x multiplicada por el
 * aspecto, para que los círculos sean círculos.
 */
export function retouchOps(r: Retouch, marks: Landmarks | null | undefined, aspect: number): RetouchOps {
  const warpA = new Float32Array(MAX_WARPS * 4)
  const warpB = new Float32Array(MAX_WARPS * 4)
  const toneA = new Float32Array(MAX_TONES * 4)
  const toneB = new Float32Array(MAX_TONES * 4)
  let warpN = 0
  let toneN = 0
  const warp = (c: V, rx: number, ry: number, type: number, a: number, b: number) => {
    if (warpN >= MAX_WARPS || (Math.abs(a) < 1e-5 && Math.abs(b) < 1e-5)) return
    warpA.set([c[0], c[1], Math.max(rx, 1e-4), Math.max(ry, 1e-4)], warpN * 4)
    warpB.set([type, a, b, 0], warpN * 4)
    warpN++
  }
  const tone = (c: V, rx: number, ry: number, type: number, amount: number, extra: V = [0, 0]) => {
    if (toneN >= MAX_TONES || amount <= 0.001) return
    toneA.set([c[0], c[1], Math.max(rx, 1e-4), Math.max(ry, 1e-4)], toneN * 4)
    toneB.set([type, amount, extra[0], extra[1]], toneN * 4)
    toneN++
  }

  const face = marks?.face
  if (face && face.length >= FACE_POINTS.length * 2) {
    const pt = (idx: (typeof FACE_POINTS)[number]): V => [face[F[idx] * 2] * aspect, 1 - face[F[idx] * 2 + 1]]
    const top = pt(10)
    const chin = pt(152)
    const center = mid(top, chin)
    const up = norm(sub(top, chin))
    const right = norm(sub(pt(454), pt(234)))
    const faceW = dist(pt(234), pt(454))
    const faceH = dist(top, chin)
    const eyeL = pt(468)
    const eyeR = pt(473)
    const eyeW = (dist(pt(33), pt(133)) + dist(pt(362), pt(263))) / 2
    const noseTip = pt(1)
    const noseW = dist(pt(129), pt(358))
    const mouthC = mid(pt(13), pt(14))
    const mouthW = dist(pt(61), pt(291))
    const eyeMid = mid(eyeL, eyeR)

    if (r.face) {
      warp(center, faceW * 0.75, faceH * 0.72, WARP_SCALE, -0.12 * r.faceSmall, -0.12 * r.faceSmall)
      for (const [jaw, k] of [[pt(172), 1], [pt(397), 1], [pt(132), 0.6], [pt(361), 0.6]] as [V, number][]) {
        const toCenter = norm(sub(center, jaw))
        warp(jaw, faceW * 0.32, faceW * 0.32, WARP_MOVE, toCenter[0] * faceW * 0.09 * r.faceSlim * k, toCenter[1] * faceW * 0.09 * r.faceSlim * k)
      }
      warp(add(center, mul(up, -faceH * 0.08)), faceW * 0.8, faceH * 0.55, WARP_SCALE, 0.1 * r.faceWide * Math.abs(right[0]), 0.1 * r.faceWide * Math.abs(right[1]))
      const hl = mul(up, -faceH * 0.07 * r.hairline)
      warp(add(top, mul(up, faceH * 0.05)), faceW * 0.5, faceH * 0.22, WARP_MOVE, hl[0], hl[1])
    }

    if (r.features) {
      for (const eye of [eyeL, eyeR]) {
        warp(eye, eyeW * 0.95, eyeW * 0.75, WARP_SCALE, 0.32 * r.eyeSize, 0.32 * r.eyeSize)
        const away = norm(sub(eye, eyeMid))
        warp(eye, eyeW * 1.1, eyeW * 0.9, WARP_MOVE, away[0] * eyeW * 0.14 * r.eyeDistance, away[1] * eyeW * 0.14 * r.eyeDistance)
        warp(eye, eyeW * 1.1, eyeW * 0.9, WARP_MOVE, up[0] * eyeW * 0.12 * r.eyeHeight, up[1] * eyeW * 0.12 * r.eyeHeight)
        tone(eye, eyeW * 0.55, eyeW * 0.32, TONE_EYE_BRIGHT, r.eyeBright)
      }
      warp(noseTip, noseW * 1.0, noseW * 1.0, WARP_SCALE, 0.2 * r.noseSize, 0.2 * r.noseSize)
      const base = mid(pt(129), pt(358))
      warp(base, noseW * 0.85, noseW * 0.5, WARP_SCALE, 0.25 * r.noseWidth * Math.abs(right[0]), 0.25 * r.noseWidth * Math.abs(right[1]))
      const bridge = mid(pt(6), pt(168))
      warp(bridge, noseW * 0.45, noseW * 0.9, WARP_SCALE, 0.3 * r.noseBridge * Math.abs(right[0]), 0.3 * r.noseBridge * Math.abs(right[1]))
      const nl = mul(up, noseW * 0.15 * r.noseHeight)
      warp(noseTip, noseW * 0.9, noseW * 0.9, WARP_MOVE, nl[0], nl[1])

      warp(mouthC, mouthW * 0.75, mouthW * 0.5, WARP_SCALE, 0.2 * r.mouthSize, 0.2 * r.mouthSize)
      warp(mouthC, mouthW * 0.7, mouthW * 0.4, WARP_SCALE, 0, 0.25 * r.lips)
      for (const corner of [pt(61), pt(291)]) {
        const lift = mul(up, mouthW * 0.06 * r.smile)
        warp(corner, mouthW * 0.32, mouthW * 0.32, WARP_MOVE, lift[0], lift[1])
      }
      const inner = Math.max(dist(pt(13), pt(14)), mouthW * 0.08)
      tone(mouthC, mouthW * 0.4, inner * 0.75, TONE_TEETH, r.teeth)

      for (const brow of [pt(105), pt(334)]) {
        const bh = mul(up, eyeW * 0.15 * r.browHeight)
        warp(brow, eyeW * 1.0, eyeW * 0.7, WARP_MOVE, bh[0], bh[1])
        warp(brow, eyeW * 0.9, eyeW * 0.35, WARP_SCALE, 0, 0.3 * r.browThick)
        tone(brow, eyeW * 0.85, eyeW * 0.28, TONE_BROW, r.browNatural)
      }
    }

    if (r.skin) {
      for (const eye of [eyeL, eyeR]) {
        // Ojera: debajo del ojo; se iguala con la mejilla (un poco más abajo).
        const under = add(eye, mul(up, -eyeW * 0.55))
        const cheek = add(eye, mul(up, -eyeW * 1.35))
        tone(under, eyeW * 0.62, eyeW * 0.3, TONE_DARK_CIRCLE, r.darkCircles, cheek)
      }
      for (const [ala, corner] of [[pt(129), pt(61)], [pt(358), pt(291)]] as [V, V][]) {
        tone(mid(ala, corner), mouthW * 0.22, mouthW * 0.38, TONE_SMILE_LINE, r.smileLines)
      }
    }
  }

  const pose = marks?.pose
  if (r.body && pose && pose.length >= 33 * 3) {
    const pt = (i: number): V => [pose[i * 3] * aspect, 1 - pose[i * 3 + 1]]
    const vis = (i: number) => pose[i * 3 + 2]
    if (vis(P.lShoulder) > 0.3 && vis(P.rShoulder) > 0.3) {
      const shL = pt(P.lShoulder)
      const shR = pt(P.rShoulder)
      const shoulders = mid(shL, shR)
      const shoulderW = dist(shL, shR)
      const hipsOk = vis(P.lHip) > 0.3 && vis(P.rHip) > 0.3
      const hips = hipsOk ? mid(pt(P.lHip), pt(P.rHip)) : add(shoulders, [0, -shoulderW * 1.3])
      const hipW = hipsOk ? dist(pt(P.lHip), pt(P.rHip)) : shoulderW * 0.7
      const torsoH = dist(shoulders, hips)
      const torso = mid(shoulders, hips)
      const head = vis(P.nose) > 0.3 ? pt(P.nose) : add(shoulders, [0, shoulderW * 0.6])

      warp(torso, shoulderW * 1.25, torsoH * 1.5, WARP_SCALE, -0.12 * r.slim, 0)
      warp(head, shoulderW * 0.5, shoulderW * 0.55, WARP_SCALE, -0.15 * r.head, -0.15 * r.head)
      const neckUp = norm(sub(head, shoulders))
      warp(head, shoulderW * 0.6, shoulderW * 0.6, WARP_MOVE, neckUp[0] * shoulderW * 0.08 * r.neck, neckUp[1] * shoulderW * 0.08 * r.neck)
      for (const [sh, el] of [[P.lShoulder, P.lElbow], [P.rShoulder, P.rElbow]]) {
        if (vis(el) < 0.3) continue
        const arm = mid(pt(sh), pt(el))
        warp(arm, shoulderW * 0.2, dist(pt(sh), pt(el)) * 0.65, WARP_SCALE, -0.25 * r.arms, 0)
      }
      warp(torso, shoulderW * 1.0, torsoH * 0.9, WARP_SCALE, -0.1 * r.bodyWidth, 0)
      warp(add(shoulders, mul(sub(hips, shoulders), 0.65)), hipW * 0.95, torsoH * 0.35, WARP_SCALE, -0.18 * r.waist, 0)
      warp(torso, shoulderW * 1.0, torsoH * 0.8, WARP_SCALE, 0, 0.08 * r.torso)
      warp(hips, hipW * 1.0, torsoH * 0.35, WARP_SCALE, 0.15 * r.hips, 0)
    }
  }

  return { warpA, warpB, warpN, toneA, toneB, toneN }
}
