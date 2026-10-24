// Iconos de trazo (estilo lucide), dibujados a mano para no depender de librerías.

const paths: Record<string, string> = {
  media: 'M3 5h18v14H3zM10 9l5 3-5 3z',
  audio: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  transitions: 'M4 4l8 8-8 8M12 4l8 8-8 8',
  adjust: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  split: 'M12 3v18M7 7l-3 5 3 5M17 7l3 5-3 5',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4',
  plus: 'M12 5v14M5 12h14',
  export: 'M12 15V3M7 8l5-5 5 5M5 21h14',
  back: 'M15 18l-6-6 6-6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z',
  folder: 'M3 6h6l2 2h10v11H3z',
  close: 'M6 6l12 12M18 6L6 18',
  live: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12',
  skim: 'M12 3v18M8 7l4-4 4 4M5 12h3M16 12h3',
  trimLeft: 'M14 4v16M5 8l4 4-4 4M18 6h2v12h-2',
  trimRight: 'M10 4v16M19 8l-4 4 4 4M6 6H4v12h2',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  freeze: 'M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1L19.1 4.9',
  reverse: 'M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-2',
  mirror: 'M12 3v18M8 7l-5 5 5 5V7zM16 7l5 5-5 5V7z',
  rotate: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  detachAudio: 'M3 8h10v8H3zM16 9l3-2v10l-3-2M13 3l-2 3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  unlink: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7M3 3l18 18',
  snap: 'M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4zM16 16h4v4h-4zM8 6h8M6 8v8M18 8v8M8 18h8',
  diamond: 'M12 3l9 9-9 9-9-9z',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chat: 'M4 5h16v11H8l-4 4z',
  layout: 'M3 4h18v16H3zM14 4v16M3 13h11',
  layoutVertical: 'M3 4h18v16H3zM9 4v16M9 12h12',
  effects: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  skipBack: 'M19 20L9 12l10-8zM5 19V5',
  skipForward: 'M5 4l10 8-10 8zM19 5v14',
  minimize: 'M8 3v5H3M21 8h-5V3M3 16h5v5M16 21v-5h5',
  alignLeft: 'M4 3v18M8 8h12v8H8z',
  alignCenterH: 'M12 3v18M6 8h12v8H6z',
  alignRight: 'M20 3v18M4 8h12v8H4z',
  alignTop: 'M3 4h18M8 8h8v12H8z',
  alignCenterV: 'M3 12h18M8 6h8v12H8z',
  alignBottom: 'M3 20h18M8 4h8v12H8z',
  send: 'M4 12l16-8-6 16-2-6z',
  stop: 'M6 6h12v12H6z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12'
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  )
}
