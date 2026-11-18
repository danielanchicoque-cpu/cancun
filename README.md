# Cancun

Editor de video para Windows con línea de tiempo, LUTs, quitar fondo y retoque de rostro hechos en local, subtítulos automáticos y exportación con la GPU. Trae un comando `cancun` para que Claude (u otro programa) edite el proyecto mientras tú ves los cambios en vivo.

<!-- PENDIENTE: captura de la interfaz. Guardar en docs/interfaz.png y reemplazar esta línea por: ![Interfaz de Cancun](docs/interfaz.png) -->

> Versión temprana (0.2.0). Funciona, pero tiene fallas y cosas a medias. Haz copia de tus proyectos importantes y, si algo se rompe, abre un issue.

## Descargar

Instalador para Windows (.exe): <https://github.com/danielanchicoque-cpu/cancun/releases/latest>

Baja `Cancun-Instalador-0.2.0.exe`, ejecútalo y abre Cancun desde el menú Inicio. Windows puede mostrar un aviso de SmartScreen porque el instalador no está firmado: "Más información" y "Ejecutar de todos modos".

Requisitos:

- Windows 10 u 11 de 64 bits.
- Una GPU NVIDIA es opcional. Con ella la exportación y los subtítulos van bastante más rápido; sin ella todo funciona por CPU.
- Espacio libre: el instalador pesa unos 180 MB y los subtítulos descargan, la primera vez, un modelo de unos 1,2 GB.

## Qué hace

- Línea de tiempo con cortes, varias capas, multiselección, imán, vinculación de clips, congelar, invertir, espejo y separar audio.
- Keyframes, animaciones de entrada y salida, mezcla de capas y máscaras.
- Transiciones y efectos propios, con vista previa al pasar el cursor.
- LUTs `.cube` y filtros `.png` (cuadrícula 8×8 o tira). Se traen solos los LUT importados en CapCut, los que usan tus proyectos de CapCut (también en la carpeta de borradores personalizada) y los filtros de CapCut que usaste; también puedes importar una carpeta entera. La vista previa y la exportación usan el mismo cálculo de color (16 bits), así que se ven igual. Capa de ajuste con intensidad y opción de proteger el tono de piel.
- Quitar fondo sin pantalla verde, y retoque de piel, rostro y cuerpo, todo con modelos que corren en tu equipo. El retoque de piel sigue la misma receta que CapCut (suavizado por separación de frecuencias que respeta ojos, cejas y labios) y suma borrar imperfecciones, eliminación de arrugas, blanqueamiento y los nueve tonos de piel de CapCut, más blanqueamiento dental y nariz estereoscópica.
- Texto y subtítulos automáticos con Whisper local.
- Audio: onda con dB, normalizar, música y efectos de sonido desde tus carpetas. Voz local: reducir ruido, aislar voz y mejorar voz con intensidad 0–100. Usa la red neuronal DeepFilterNet (se descarga sola la primera vez, 27 MB) más el motor espectral propio de Cancun; si no hay internet la primera vez, usa solo el motor propio. Medido contra CapCut: aislar voz 9 dB de SI-SDR (el motor propio solo, 4), reducir ruido 11 (solo, 9). Se procesa una vez, queda en caché y se oye en la vista previa.
- Guardado automático y copias de respaldo.
- Exportación con control de bitrate; usa NVENC si tienes GPU NVIDIA.
- Chat dentro de la app y CLI `cancun` para editar por comandos (`cancun help` lista todo).

Lo que todavía no está: la exportación con fondo quitado o con retoque de cara es lenta (la detección corre en cada cuadro: unos 4 a 13 cuadros por segundo según el equipo).

### Limpiar clips para otro editor (HyperFrames)

`cancun clean <videos...>` deja cada video como `<nombre>-limpio.mp4` con retoque de piel y voz limpia (por defecto: retoque natural, reducir ruido y mejorar voz al 75). En `skills/cancun-limpieza/` está la habilidad para Claude que lo usa antes de montar en HyperFrames.

## Compilar desde el código

Necesitas Node.js 20.19 o superior y Git.

```bash
git clone https://github.com/danielanchicoque-cpu/cancun.git
cd cancun
npm install
```

FFmpeg no viene en el repositorio. Descarga la build "essentials" 7.0.2 de gyan.dev (<https://github.com/GyanD/codexffmpeg/releases/tag/7.0.2>), y copia `ffmpeg.exe` y `ffprobe.exe` a `vendor/ffmpeg/` (junto con el archivo `LICENSE` de esa build). Sirve la 7.0.2 en concreto: las 7.1 y posteriores piden un driver NVIDIA más nuevo para NVENC. También puedes apuntar a otro FFmpeg con las variables `CANCUN_FFMPEG` y `CANCUN_FFPROBE`.

```bash
npm run dev        # abre la app con recarga
npm test           # pruebas del núcleo
npm run typecheck
npm run dist       # genera el instalador en dist/
```

Para probar sin tocar una Cancun ya instalada y abierta, usa un perfil aparte: `CANCUN_PROFILE=dev npm run dev`.

El chat integrado usa la sesión de Claude Code de tu terminal: ejecuta `claude` y haz `/login` una vez.

## Estructura

- `src/shared/` núcleo sin Electron: modelo del proyecto, operaciones de edición, color, línea de tiempo y exportación.
- `src/main/` proceso principal: guardado, LUTs, FFmpeg, subtítulos, puente con el CLI.
- `src/renderer/` interfaz React y vista previa en WebGL2.
- `cli/cancun.mjs` el comando `cancun`.
- `skills/` habilidades para Claude (limpieza de clips antes de HyperFrames).

## Créditos

- [MediaPipe](https://github.com/google-ai-edge/mediapipe) (Google, Apache 2.0): segmentación para quitar fondo y detección de rostro y cuerpo para el retoque.
- [FFmpeg](https://ffmpeg.org/) (build de [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), GPL v3): mezcla de audio y codificación. Se ejecuta como programa aparte.
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (MIT/Apache 2.0): reducción de ruido y aislamiento de voz. Se descarga la primera vez que se usa.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) con el modelo de OpenAI Whisper (MIT): subtítulos. Se descargan la primera vez que se usan.
- [Electron](https://www.electronjs.org/), [React](https://react.dev/), [mp4box.js](https://github.com/gpac/mp4box.js), [zustand](https://github.com/pmndrs/zustand) y [ws](https://github.com/websockets/ws).

Cancun no es un producto de CapCut ni de ByteDance y no incluye nada de su software ni de sus bibliotecas de efectos o música. Lee los formatos `.cube` por compatibilidad.

## Licencia

[MIT](LICENSE) para el código de Cancun. Las dependencias y los binarios de terceros conservan sus propias licencias. Las fotos de `resources/samples/` son imágenes de muestra generadas con IA.
