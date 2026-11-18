---
name: cancun-limpieza
description: Limpia clips grabados con celular antes de montarlos (HyperFrames u otro editor) usando Cancun en local: retoque de piel como CapCut (suavizar, borrar imperfecciones, arrugas, blanqueamiento, tono, dientes, nariz) y voz (reducir ruido, aislar voz, mejorar voz). Úsala siempre que un video tenga una persona hablando a cámara o voz grabada en el lugar, antes de meterlo en una composición, o cuando pidan "suavizar la cara", "quitar imperfecciones", "quitar el ruido", "mejorar la voz" o "aislar la voz".
---

# Limpieza de clips con Cancun

Cancun (https://github.com/danielanchicoque-cpu/cancun) trae un motor local de retoque de
rostro y de voz afinado contra los resultados de CapCut. Esta habilidad lo usa como paso
previo: los clips crudos entran, salen `<nombre>-limpio.mp4` con el mismo tamaño y fps, y
esos son los que se usan en HyperFrames.

## Cuándo

- Casi siempre que haya voz grabada con el celular: **reducir ruido + mejorar voz** (75).
- Si hay música o gente hablando de fondo: **aislar voz** en vez de reducir ruido.
- Cara en primer plano: **retoque natural**. Piel con acné o marcas: **fuerte**.
- No usarla en pantallas grabadas, animaciones ni material sin personas ni voz.

## Cómo

1. Cancun tiene que estar abierto: `cancun launch`. Si `cancun` no está en el PATH, usar
   `node "<carpeta de Cancun>/cli/cancun.mjs" <comando>` (en este equipo:
   `C:/Users/elkin/Desktop/Cancun Mejoras/cli/cancun.mjs`). Hace falta la versión de Cancun
   con el motor nuevo (esta rama o un instalador hecho desde ella).
2. Limpiar (uno o varios videos):

```bash
cancun clean "C:/ruta/IMG_7979.MOV" "C:/ruta/IMG_7973.MOV" --out-dir "C:/ruta/limpios"
```

Opciones:

| Opción | Valores | Por defecto |
|---|---|---|
| `--retouch` | `suave`, `natural`, `fuerte`, `ninguno` | `natural` |
| `--voice` | `reducir` (≈13 dB menos de fondo), `aislar` (solo voz, silencia huecos), `ninguno` | `reducir` |
| `--enhance` | `0`, `0.25`, `0.5`, `0.75`, `1` ("Mejorar voz", como en CapCut) | `0.75` |
| `--normalize` | lleva a −14 LUFS (redes) | apagado |

Recetas de retoque: `suave` = suavizar 25 + imperfecciones 30; `natural` = suavizar 40 +
imperfecciones 50 + arrugas 30 + blanqueamiento 10 + dientes 20; `fuerte` = suavizar 55 +
imperfecciones 80 + arrugas 50 + tono uniforme 30 + blanqueamiento 15 + dientes 30.

3. Revisar un cuadro antes de seguir (el retoque se nota mejor de cerca):

```bash
ffmpeg -ss 3 -i limpio.mp4 -frames:v 1 cuadro.png
```

4. Usar los `*-limpio.mp4` en la composición de HyperFrames en lugar de los originales.

## Ajuste fino (en vez de `clean`)

Para valores a medida, editar el clip en Cancun y exportar:

```bash
cancun new retoque --size 1080x1920
cancun import "C:/ruta/clip.MOV" --add
cancun summary                       # id del clip
cancun apply '{"op":"updateClip","clipId":"ID","patch":{"retouch":{"smooth":0.39,"removeBlemishes":0.6,"wrinkles":0.3,"noseWidth":0.51,"noseStereo":0.24,"teeth":0.22},"audioFx":{"denoise":true,"enhanceVoice":true,"enhanceAmount":0.75}}}'
cancun frame --time 3 --out antes-despues.png
cancun export "C:/ruta/clip-limpio.mp4"
```

Claves de retoque (0..1 salvo que se diga): `smooth`, `whiten`, `removeBlemishes`,
`wrinkles`, `evenTone`, `darkCircles`, `smileLines`, `skinTone` (uno de los 9 colores de
`cancun ops`) con `skinToneAmount`, `teeth`, `noseStereo`, `browNatural`; y de −1 a 1:
`noseWidth`, `noseSize`, `eyeSize`, `faceSlim`, etc. `cancun ops` tiene la lista completa.

## Notas

- Todo corre en el equipo; la primera vez la voz tarda unos segundos por minuto de audio
  y queda en caché.
- Los videos verticales del iPhone (HEVC con giro y HDR) se leen derechos.
- Exportar con retoque va a unos 4–7 cuadros por segundo en una laptop con RTX 4050
  (la detección de la cara corre en cada cuadro).
