// electron-vite: `import ruta from './archivo?modulePath'` compila el archivo aparte
// (para worker_threads) y devuelve la ruta del resultado.
declare module '*?modulePath' {
  const path: string
  export default path
}
