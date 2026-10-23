// Catálogos de la interfaz (nombres en español de transiciones, efectos, mezclas…).

import type { BlendMode, MaskShape, TextStyle, TransitionKind } from '@shared/project'

export const TRANSITIONS: { kind: TransitionKind; label: string; group: string }[] = [
  { kind: 'fade', label: 'Fundido', group: 'Básicas' },
  { kind: 'dissolve', label: 'Disolver', group: 'Básicas' },
  { kind: 'fadeblack', label: 'Fundido a negro', group: 'Básicas' },
  { kind: 'fadewhite', label: 'Destello blanco', group: 'Básicas' },
  { kind: 'flash', label: 'Flash', group: 'Básicas' },
  { kind: 'blur', label: 'Desenfoque', group: 'Básicas' },
  { kind: 'slideleft', label: 'Deslizar ←', group: 'Movimiento' },
  { kind: 'slideright', label: 'Deslizar →', group: 'Movimiento' },
  { kind: 'slideup', label: 'Deslizar ↑', group: 'Movimiento' },
  { kind: 'slidedown', label: 'Deslizar ↓', group: 'Movimiento' },
  { kind: 'zoomin', label: 'Acercar', group: 'Movimiento' },
  { kind: 'zoomblur', label: 'Zoom radial', group: 'Movimiento' },
  { kind: 'spin', label: 'Giro', group: 'Movimiento' },
  { kind: 'squeeze', label: 'Apretar', group: 'Movimiento' },
  { kind: 'cube', label: 'Cubo', group: 'Movimiento' },
  { kind: 'doorway', label: 'Puertas', group: 'Movimiento' },
  { kind: 'wipeleft', label: 'Barrido ←', group: 'Barridos' },
  { kind: 'wiperight', label: 'Barrido →', group: 'Barridos' },
  { kind: 'smoothleft', label: 'Barrido suave', group: 'Barridos' },
  { kind: 'windowslice', label: 'Persianas', group: 'Barridos' },
  { kind: 'radial', label: 'Radial', group: 'Barridos' },
  { kind: 'circleopen', label: 'Círculo abrir', group: 'Barridos' },
  { kind: 'circleclose', label: 'Círculo cerrar', group: 'Barridos' },
  { kind: 'heart', label: 'Corazón', group: 'Barridos' },
  { kind: 'pagecurl', label: 'Pasar página', group: 'Barridos' },
  { kind: 'glitch', label: 'Glitch', group: 'Efectos' },
  { kind: 'pixelize', label: 'Pixelar', group: 'Efectos' },
  { kind: 'mosaic', label: 'Mosaico', group: 'Efectos' },
  { kind: 'swirl', label: 'Remolino', group: 'Efectos' },
  { kind: 'ripple', label: 'Ondas', group: 'Efectos' },
  { kind: 'burn', label: 'Quemar', group: 'Efectos' },
  { kind: 'luma', label: 'Por luz', group: 'Efectos' },
  { kind: 'colorphase', label: 'Fase de color', group: 'Efectos' },
  { kind: 'morph', label: 'Transformar', group: 'Efectos' },
  { kind: 'directionalwarp', label: 'Deformar', group: 'Efectos' },
  { kind: 'crosswarp', label: 'Deformar cruzado', group: 'Efectos' }
]

export const BLENDS: { mode: BlendMode; label: string }[] = [
  { mode: 'normal', label: 'Predeterminado' },
  { mode: 'lighten', label: 'Aclarar' },
  { mode: 'screen', label: 'Trama (iluminar pantalla)' },
  { mode: 'colorDodge', label: 'Sobreexponer color' },
  { mode: 'linearDodge', label: 'Añadir' },
  { mode: 'darken', label: 'Oscurecer' },
  { mode: 'multiply', label: 'Multiplicar' },
  { mode: 'colorBurn', label: 'Subexponer color' },
  { mode: 'linearBurn', label: 'Subexposición lineal' },
  { mode: 'overlay', label: 'Superposición' },
  { mode: 'softLight', label: 'Luz suave' },
  { mode: 'hardLight', label: 'Luz fuerte' },
  { mode: 'difference', label: 'Diferencia' },
  { mode: 'exclusion', label: 'Exclusión' }
]

export const MASKS: { shape: MaskShape; label: string }[] = [
  { shape: 'none', label: 'Ninguna' },
  { shape: 'linear', label: 'Lineal' },
  { shape: 'mirror', label: 'Espejo' },
  { shape: 'circle', label: 'Círculo' },
  { shape: 'rectangle', label: 'Rectángulo' },
  { shape: 'heart', label: 'Corazón' },
  { shape: 'star', label: 'Estrella' }
]

export const TEXT_PRESETS: { label: string; text: string; style: Partial<TextStyle> }[] = [
  { label: 'Texto predeterminado', text: 'Texto predeterminado', style: {} },
  { label: 'Borde negro', text: 'Borde negro', style: { strokeWidth: 1, strokeColor: '#000000' } },
  { label: 'Caja', text: 'Caja', style: { background: '#000000', color: '#ffffff', bold: true, size: 56 } },
  { label: 'Amarillo', text: 'Amarillo', style: { color: '#ffd400', strokeWidth: 1, strokeColor: '#000000', size: 84 } },
  { label: 'Título', text: 'TÍTULO', style: { size: 120, bold: true, font: 'Impact' } },
  { label: 'Subtítulo', text: 'Subtítulo', style: { size: 54, bold: true, strokeWidth: 0.6, strokeColor: '#000000' } },
  { label: 'Rojo', text: 'Rojo', style: { color: '#ff3b3b', strokeWidth: 1, strokeColor: '#ffffff', size: 90, font: 'Impact' } },
  { label: 'Caja blanca', text: 'Caja blanca', style: { background: '#ffffff', color: '#111111', size: 56 } }
]
