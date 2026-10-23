# Cancun

Editor de video de escritorio de Daniel, inspirado en CapCut, con un CLI para que Claude edite en vivo.

## Uso

```bash
npm install
npm run build
cancun launch        # abre la app (el comando `cancun` queda global con `npm link`)
```

Desarrollo con recarga: `npm run dev`. Pruebas: `npm test`.

## Arquitectura

- `src/shared/` — núcleo puro, sin Electron: modelo del proyecto (`project.ts`), operaciones de edición
  (`ops.ts`, las usan la UI, el CLI y el deshacer), lector `.cube` (`cube.ts`), color horneado en un LUT 3D
  (`color.ts`), qué se ve en cada instante (`timeline.ts`) y el grafo de exportación de FFmpeg (`exportGraph.ts`).
- `src/main/` — proceso principal: guardado automático con respaldos, biblioteca de LUTs (importa los de CapCut),
  ffprobe/miniaturas/forma de onda, exportación con detección de codificador, puente WebSocket para el CLI.
- `src/renderer/` — interfaz React; vista previa en WebGL2 (`gl/`), motor de reproducción (`engine/Player.ts`).
- `cli/cancun.mjs` — CLI (`cancun help`, `cancun ops`).

La vista previa y la exportación usan la misma función de color (LUT + ajustes horneados en un LUT 3D) y las
mismas fórmulas de transición (port de `xfade` de FFmpeg), por eso se ven igual.

Datos: proyectos en `Documentos\Cancun\Proyectos`, LUTs en `Documentos\Cancun\LUTs`.
