// Keyframes y animaciones: dado un clip y un instante, devuelve el clip con los
// valores que tiene en ese momento. Lo usan la vista previa, la exportación y el CLI.

import type { Animation, Clip, Easing, KeyProp, Keyframe } from './project.ts'
import { US } from './project.ts'

const ease: Record<Easing, (x: number) => number> = {
  linear: (x) => x,
  easeIn: (x) => x * x * x,
  easeOut: (x) => 1 - Math.pow(1 - x, 3),
  easeInOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  hold: () => 0
}

export function interpolate(kfs: Keyframe[], t: number): number {
  if (t <= kfs[0].t) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.v
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.t && t <= b.t) {
      const x = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t)
      return a.v + (b.v - a.v) * ease[a.ease](x)
    }
  }
  return last.v
}

export function getPath(obj: unknown, path: string): number | undefined {
  let cur = obj as Record<string, unknown> | null | undefined
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key] as Record<string, unknown>
  }
  return typeof cur === 'number' ? cur : undefined
}

export function setPath(obj: unknown, path: string, value: number) {
  const keys = path.split('.')
  let cur = obj as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== 'object') return
    cur = cur[key] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = value
}

// --- Animaciones ------------------------------------------------------------------------

export interface AnimDelta {
  dx: number
  dy: number
  scale: number
  rotation: number
  opacity: number
}

const none = (): AnimDelta => ({ dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 })

/**
 * Cada animación describe cómo se ve el clip "fuera de escena" en función de q:
 * q = 0 → estado normal, q = 1 → totalmente fuera. Entrada y salida usan la misma
 * curva en sentidos opuestos.
 */
const shapes: Record<string, (q: number) => Partial<AnimDelta>> = {
  fade: (q) => ({ opacity: 1 - q }),
  zoomIn: (q) => ({ scale: 1 - 0.4 * q, opacity: 1 - q }),
  zoomOut: (q) => ({ scale: 1 + 0.5 * q, opacity: 1 - q }),
  slideLeft: (q) => ({ dx: 2 * q }),
  slideRight: (q) => ({ dx: -2 * q }),
  slideUp: (q) => ({ dy: 2 * q }),
  slideDown: (q) => ({ dy: -2 * q }),
  rotate: (q) => ({ rotation: -90 * q, scale: 1 - 0.3 * q, opacity: 1 - q }),
  spin: (q) => ({ rotation: 360 * q, scale: 1 - 0.8 * q }),
  pop: (q) => ({ scale: 1 - q + Math.sin(q * Math.PI) * 0.25, opacity: Math.min(1, (1 - q) * 3) }),
  drop: (q) => ({ dy: -1.2 * q, opacity: 1 - q * 0.5 }),
  swing: (q) => ({ rotation: 25 * q, dx: 0.3 * q, opacity: 1 - q })
}

export const ANIMATIONS: { name: string; label: string }[] = [
  { name: 'fade', label: 'Fundido' },
  { name: 'zoomIn', label: 'Acercar' },
  { name: 'zoomOut', label: 'Alejar' },
  { name: 'slideLeft', label: 'Deslizar ←' },
  { name: 'slideRight', label: 'Deslizar →' },
  { name: 'slideUp', label: 'Deslizar ↑' },
  { name: 'slideDown', label: 'Deslizar ↓' },
  { name: 'rotate', label: 'Girar' },
  { name: 'spin', label: 'Remolino' },
  { name: 'pop', label: 'Rebote' },
  { name: 'drop', label: 'Caer' },
  { name: 'swing', label: 'Balanceo' }
]

const combos: Record<string, (phase: number) => Partial<AnimDelta>> = {
  pulse: (ph) => ({ scale: 1 + 0.06 * Math.sin(ph * Math.PI * 2) }),
  shake: (ph) => ({ dx: 0.012 * Math.sin(ph * Math.PI * 22), dy: 0.012 * Math.cos(ph * Math.PI * 17) }),
  swing: (ph) => ({ rotation: 6 * Math.sin(ph * Math.PI * 2) }),
  float: (ph) => ({ dy: 0.03 * Math.sin(ph * Math.PI * 2) }),
  spin: (ph) => ({ rotation: 360 * ph }),
  breathe: (ph) => ({ scale: 1 + 0.04 * (1 - Math.cos(ph * Math.PI * 2)) / 2, opacity: 0.85 + 0.15 * Math.cos(ph * Math.PI * 2) })
}

export const COMBOS: { name: string; label: string }[] = [
  { name: 'pulse', label: 'Latido' },
  { name: 'shake', label: 'Temblor' },
  { name: 'swing', label: 'Péndulo' },
  { name: 'float', label: 'Flotar' },
  { name: 'spin', label: 'Girar' },
  { name: 'breathe', label: 'Respirar' }
]

function apply(d: AnimDelta, part: Partial<AnimDelta>) {
  d.dx += part.dx ?? 0
  d.dy += part.dy ?? 0
  d.scale *= part.scale ?? 1
  d.rotation += part.rotation ?? 0
  d.opacity *= Math.max(0, Math.min(1, part.opacity ?? 1))
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)

export function animationDelta(clip: Clip, local: number): AnimDelta {
  const d = none()
  const { in: inA, out: outA, combo } = clip.animations
  const dur = clip.duration
  const span = (a: Animation) => Math.max(1, Math.min(a.duration, dur))
  if (inA && shapes[inA.name] && local < span(inA)) apply(d, shapes[inA.name](1 - easeOut(local / span(inA))))
  if (outA && shapes[outA.name] && local > dur - span(outA)) apply(d, shapes[outA.name](1 - easeOut((dur - local) / span(outA))))
  if (combo && combos[combo.name]) apply(d, combos[combo.name]((local % Math.max(1, combo.duration)) / Math.max(1, combo.duration)))
  return d
}

/** El clip con sus valores en el instante `t` de la línea de tiempo (keyframes + animaciones). */
export function resolveClip<T extends Clip>(clip: T, t: number): T {
  const local = t - clip.start
  const hasKeys = Object.keys(clip.keyframes).length > 0
  const { in: a, out: b, combo } = clip.animations
  if (!hasKeys && !a && !b && !combo) return clip
  const c = structuredClone(clip)
  for (const [prop, kfs] of Object.entries(clip.keyframes) as [KeyProp, Keyframe[]][]) {
    if (kfs?.length) setPath(c, prop, interpolate(kfs, local))
  }
  const d = animationDelta(clip, local)
  c.transform.x += d.dx
  c.transform.y += d.dy
  c.transform.scale *= d.scale
  if (c.transform.scaleY !== null) c.transform.scaleY *= d.scale
  c.transform.rotation += d.rotation
  c.transform.opacity *= d.opacity
  return c
}

export const DEFAULT_ANIMATION_US = 0.5 * US
