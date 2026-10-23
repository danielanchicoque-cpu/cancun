import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared },
    // MediaPipe carga su WASM con importScripts: el worker debe ser clásico (iife).
    worker: { format: 'iife' },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), render: resolve('src/renderer/render.html') } }
    }
  }
})
