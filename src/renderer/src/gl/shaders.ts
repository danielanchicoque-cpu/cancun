export const QUAD_VS = `#version 300 es
in vec2 aPos;
uniform mat3 uMatrix;   // de unidad (0..1) a espacio del lienzo en píxeles
uniform vec2 uCanvas;
out vec2 vUv;
void main() {
  vec3 p = uMatrix * vec3(aPos, 1.0);
  vec2 clip = (p.xy / uCanvas) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aPos;
}`

/** Dibuja un clip de video/imagen con todo su procesamiento por píxel. */
export const LAYER_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler3D uGrade;
uniform sampler2D uSeg;        // r = persona, g = piel (segmentación)
uniform bool uHasSeg;
uniform bool uUseGrade;
uniform float uGradeSize;
uniform float uOpacity;
uniform vec4 uCrop;            // izq, arriba, der, abajo (fracciones)
uniform vec2 uFlip;
uniform vec2 uTexel;           // 1/tamaño de la fuente
uniform vec2 uClipPx;          // tamaño del clip en píxeles del lienzo
uniform float uSharpen;
uniform float uVignette;
uniform bool uChroma;
uniform vec3 uKey;
uniform float uKeyIntensity;
uniform float uKeyShadow;
uniform bool uRemoveBg;
uniform float uBgFeather;
uniform float uBgShrink;
uniform vec4 uRetouch;         // suavizar, blanquear, imperfecciones, tono uniforme
uniform vec4 uSkinTone;        // rgb del tono elegido, cantidad (0 = natural)
// Retoque de rostro y cuerpo: deformaciones locales y zonas de tono (ver shared/retouch.ts).
// Coordenadas en uv de la textura con x multiplicada por uAspect.
uniform int uWarpN;
uniform vec4 uWarpA[24];       // centro, radios
uniform vec4 uWarpB[24];       // tipo (0 escala, 1 mover), a, b
uniform int uToneN;
uniform vec4 uToneA[10];
uniform vec4 uToneB[10];       // tipo, cantidad, extra
uniform float uAspect;
// Máscara: forma (0 nada, 1 lineal, 2 espejo, 3 círculo, 4 rectángulo, 5 corazón, 6 estrella)
uniform int uMaskShape;
uniform vec4 uMaskRect;        // centro x,y (-1..1), ancho, alto (fracción)
uniform vec3 uMaskParams;      // rotación (rad), difuminado, redondez
uniform bool uMaskInvert;
// Iluminación
uniform bool uLight;
uniform vec3 uLightColor;
uniform vec4 uLightParams;     // x, y, radio, intensidad
uniform bool uLightSubject;
uniform bool uProtectSkin;
out vec4 outColor;

// Probabilidad de piel por color (YCbCr): sirve para "Proteger el tono de la piel"
// cuando no hay máscara de segmentación (capas de ajuste).
float skinByColor(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5));
  float cr = 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312));
  float d = length(vec2((cb - 0.405) / 0.065, (cr - 0.6) / 0.06));
  return (1.0 - smoothstep(0.7, 1.35, d)) * smoothstep(0.1, 0.22, y);
}


vec3 grade(vec3 c) {
  if (!uUseGrade) return c;
  vec3 coord = clamp(c, 0.0, 1.0) * ((uGradeSize - 1.0) / uGradeSize) + 0.5 / uGradeSize;
  return texture(uGrade, coord).rgb;
}

vec2 chromaUV(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec2((c.b - y) * 0.5389, (c.r - y) * 0.635);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot(p - vec2(0.25, 0.75), p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)), dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

float sdStar(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

float maskAlpha() {
  if (uMaskShape == 0) return 1.0;
  // Coordenadas en píxeles del clip, centradas en la máscara.
  vec2 p = (vUv - 0.5) * uClipPx - uMaskRect.xy * 0.5 * uClipPx;
  float c = cos(-uMaskParams.x), s = sin(-uMaskParams.x);
  p = mat2(c, -s, s, c) * p;
  vec2 size = max(uMaskRect.zw * uClipPx * 0.5, vec2(1.0));
  float feather = max(uMaskParams.y * min(uClipPx.x, uClipPx.y) * 0.5, 1.0);
  float d;
  if (uMaskShape == 1) d = p.y;
  else if (uMaskShape == 2) d = abs(p.y) - size.y;
  else if (uMaskShape == 3) d = (length(p / size) - 1.0) * min(size.x, size.y);
  else if (uMaskShape == 4) d = sdRoundBox(p, size, uMaskParams.z * min(size.x, size.y));
  else if (uMaskShape == 5) d = sdHeart(vec2(p.x, -p.y) / size.y * 0.9 + vec2(0.0, 0.5)) * size.y;
  else d = sdStar(p / size.y, 0.9, 0.45) * size.y;
  float a = 1.0 - smoothstep(-feather, feather, d);
  return uMaskInvert ? 1.0 - a : a;
}

// La máscara de persona viene a 256 px: se sube a resolución completa promediando
// vecinos de color parecido (filtro bilateral conjunto), así el borde sigue la imagen.
float refinedPerson(vec2 uv, vec3 c) {
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      vec2 o = vec2(float(i), float(j)) * (0.75 / 256.0);
      float m = texture(uSeg, uv + o).r;
      vec3 s = texture(uSrc, uv + o).rgb;
      float w = exp(-dot(s - c, s - c) * 24.0) * exp(-float(i * i + j * j) / 4.0);
      sum += m * w;
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-4);
}

// YCbCr (BT.709) para tocar la luz sin mover el color, y al revés.
vec3 toYcc(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec3(y, (c.b - y) * 0.5389, (c.r - y) * 0.635);
}
vec3 fromYcc(vec3 v) {
  float r = v.x + v.z / 0.635;
  float b = v.x + v.y / 0.5389;
  float g = (v.x - 0.2126 * r - 0.0722 * b) / 0.7152;
  return vec3(r, g, b);
}

// Promedio bilateral (vecinos parecidos, respeta bordes) con radio en píxeles.
vec3 bilateral(vec2 uv, vec3 c, float radius, float sharp) {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    for (int j = -3; j <= 3; j++) {
      vec2 o = vec2(float(i), float(j)) * radius / 3.0;
      vec3 s = texture(uSrc, uv + o * uTexel).rgb;
      float w = exp(-dot(o, o) / (2.0 * radius * radius)) * exp(-dot(s - c, s - c) * sharp);
      sum += s * w;
      wsum += w;
    }
  }
  return sum / wsum;
}

vec3 retouch(vec2 uv, vec3 c, float skin) {
  if (skin <= 0.001) return c;
  float smoothAmt = uRetouch.x;
  if (smoothAmt > 0.0 || uRetouch.z > 0.0) {
    // Solo se suaviza la luz (la textura de la piel); el color queda igual, así el tono
    // de la piel (y el del LUT) no cambia al suavizar.
    vec3 blurred = bilateral(uv, c, 1.0 + 6.0 * max(smoothAmt, uRetouch.z * 0.7), 55.0);
    vec3 a = toYcc(c);
    vec3 b = toYcc(blurred);
    float amt = clamp(smoothAmt * 0.85 + uRetouch.z * 0.5, 0.0, 1.0) * skin;
    a.x = mix(a.x, b.x, amt);
    a.yz = mix(a.yz, b.yz, amt * 0.35);
    c = fromYcc(a);
  }
  if (uRetouch.w > 0.0) {
    // Tono uniforme: acerca el color (no la luz) de la piel a su tono medio.
    vec3 a = toYcc(c);
    vec3 avg = toYcc(textureLod(uSrc, uv, 4.0).rgb);
    a.yz = mix(a.yz, avg.yz, uRetouch.w * 0.6 * skin);
    c = fromYcc(a);
  }
  if (uRetouch.y > 0.0) {
    // Blanqueamiento natural: sube la luz con una curva suave (más en los medios que en
    // las luces) y quita apenas un poco de saturación; sin lavar a gris.
    vec3 a = toYcc(c);
    float k = 0.32 * uRetouch.y * skin;
    a.x = a.x + k * a.x * (1.0 - a.x) * 1.6;
    a.yz *= 1.0 - 0.18 * k;
    c = fromYcc(a);
  }
  if (uSkinTone.w > 0.0) {
    // Tono de piel elegido: lleva el color de la piel hacia el de la muestra.
    vec3 a = toYcc(c);
    vec3 t = toYcc(uSkinTone.rgb);
    a.yz = mix(a.yz, t.yz, uSkinTone.w * 0.7 * skin);
    c = fromYcc(a);
  }
  return c;
}

vec2 toAsp(vec2 uv) { return vec2(uv.x * uAspect, uv.y); }

// Deformaciones (licuar): para cada punto de salida se busca de dónde viene en la fuente.
vec2 warpUv(vec2 uv) {
  if (uWarpN == 0) return uv;
  vec2 q = toAsp(uv);
  vec2 src = q;
  for (int i = 0; i < 24; i++) {
    if (i >= uWarpN) break;
    vec4 A = uWarpA[i];
    vec4 B = uWarpB[i];
    vec2 d = (q - A.xy) / A.zw;
    float r2 = dot(d, d);
    if (r2 >= 1.0) continue;
    float w = (1.0 - r2) * (1.0 - r2);
    if (B.x < 0.5) {
      // Escala: agrandar (a, b > 0) o achicar alrededor del centro.
      vec2 k = vec2(1.0) + B.yz * w;
      src += (A.xy + (q - A.xy) / k) - q;
    } else {
      src -= B.yz * w;
    }
  }
  return vec2(src.x / uAspect, src.y);
}

float zoneW(vec2 uv, vec4 A) {
  vec2 d = (toAsp(uv) - A.xy) / A.zw;
  float r2 = dot(d, d);
  return r2 >= 1.0 ? 0.0 : (1.0 - r2) * (1.0 - r2);
}

// Zonas de tono del rostro: ojeras, líneas de sonrisa, dientes, brillo de ojos, cejas.
vec3 faceTones(vec2 uv, vec3 c) {
  for (int i = 0; i < 10; i++) {
    if (i >= uToneN) break;
    vec4 A = uToneA[i];
    vec4 B = uToneB[i];
    float w = zoneW(uv, A) * B.y;
    if (w <= 0.0) continue;
    int kind = int(B.x + 0.5);
    vec3 a = toYcc(c);
    if (kind == 1) {
      // Ojera: iguala la luz (y algo del color) con la mejilla.
      vec2 cheekUv = vec2(B.z / uAspect, B.w);
      vec3 cheek = toYcc(bilateral(cheekUv, texture(uSrc, cheekUv).rgb, 4.0, 20.0));
      vec3 soft = toYcc(bilateral(uv, c, 3.0, 40.0));
      a.x = mix(a.x, max(soft.x, mix(soft.x, cheek.x, 0.85)), w * 0.9);
      a.yz = mix(a.yz, cheek.yz, w * 0.45);
    } else if (kind == 2) {
      // Línea de sonrisa: suaviza el surco y lo aclara un poco.
      vec3 soft = toYcc(bilateral(uv, c, 6.0, 25.0));
      a.x = mix(a.x, max(a.x, soft.x), w * 0.9);
      a.yz = mix(a.yz, soft.yz, w * 0.5);
    } else if (kind == 3) {
      // Dientes: lo claro y poco saturado dentro de la boca se blanquea.
      float sat = length(a.yz);
      float teeth = smoothstep(0.22, 0.45, a.x) * (1.0 - smoothstep(0.06, 0.16, sat));
      a.yz *= 1.0 - 0.75 * w * teeth;
      a.x += (1.0 - a.x) * 0.22 * w * teeth;
    } else if (kind == 4) {
      // Brillo de ojos: más contraste y un poco más de luz.
      a.x = mix(a.x, clamp((a.x - 0.5) * 1.25 + 0.55, 0.0, 1.0), w * 0.8);
    } else {
      // Cejas "natural": rellena y define lo oscuro de la ceja.
      float dark = 1.0 - smoothstep(0.15, 0.45, a.x);
      a.x *= 1.0 - 0.35 * w * dark;
      a.yz *= 1.0 - 0.2 * w * dark;
    }
    c = fromYcc(a);
  }
  return c;
}

void main() {
  vec2 uv = vec2(mix(uCrop.x, 1.0 - uCrop.z, vUv.x), mix(uCrop.y, 1.0 - uCrop.w, vUv.y));
  if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
  if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
  uv = warpUv(uv);
  vec4 src = texture(uSrc, uv);
  vec3 c = src.rgb;
  vec4 seg = uHasSeg ? texture(uSeg, uv) : vec4(1.0, 0.0, 0.0, 1.0);
  if ((uRetouch != vec4(0.0) || uSkinTone.w > 0.0) && uHasSeg) c = retouch(uv, c, seg.g);
  if (uToneN > 0) c = faceTones(uv, c);
  if (uSharpen > 0.0) {
    vec3 blur = (
      texture(uSrc, uv + vec2(uTexel.x, 0.0)).rgb + texture(uSrc, uv - vec2(uTexel.x, 0.0)).rgb +
      texture(uSrc, uv + vec2(0.0, uTexel.y)).rgb + texture(uSrc, uv - vec2(0.0, uTexel.y)).rgb) * 0.25;
    c = c + (c - blur) * uSharpen * 1.5;
  }
  float alpha = src.a;
  if (uChroma) {
    float d = distance(chromaUV(src.rgb), chromaUV(uKey));
    float sim = 0.05 + uKeyIntensity * 0.5;
    float blend = max(uKeyShadow * 0.5, 0.0001);
    alpha *= clamp((d - sim * 0.35) / (blend * 0.35), 0.0, 1.0);
  }
  float person = (uRemoveBg || (uLight && uLightSubject)) && uHasSeg ? refinedPerson(uv, src.rgb) : 1.0;
  if (uRemoveBg) {
    float m = person;
    float lo = clamp(0.5 + uBgShrink * 0.35 - uBgFeather * 0.45, 0.0, 0.99);
    float hi = clamp(0.5 + uBgShrink * 0.35 + uBgFeather * 0.45, lo + 0.01, 1.0);
    alpha *= smoothstep(lo, hi, m);
  }
  vec3 ungraded = c;
  c = grade(c);
  if (uProtectSkin) c = mix(c, ungraded, (uHasSeg ? max(seg.g, skinByColor(ungraded) * 0.5) : skinByColor(ungraded)) * 0.85);
  if (uLight) {
    vec2 lp = (uLightParams.xy * 0.5 + 0.5);
    vec2 d = (vUv - lp) * uClipPx / max(uClipPx.x, uClipPx.y);
    float fall = exp(-dot(d, d) / max(uLightParams.z * uLightParams.z * 0.25, 0.0001));
    float w = uLightParams.w * fall * (uLightSubject && uHasSeg ? person : 1.0);
    c = 1.0 - (1.0 - c) * (1.0 - uLightColor * w);
  }
  if (uVignette > 0.0) {
    vec2 q = vUv - 0.5;
    c *= mix(1.0, smoothstep(0.85, 0.2, length(q) * 1.4), uVignette * 0.9);
  }
  float a = alpha * uOpacity * maskAlpha();
  outColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}`

/** Pinta una textura (premultiplicada) tal cual; sirve para componer capas y para texto. */
export const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uOpacity;
uniform bool uFlipY;
out vec4 outColor;
void main() { outColor = texture(uSrc, uFlipY ? vec2(vUv.x, 1.0 - vUv.y) : vUv) * uOpacity; }`

export const BLEND_MODES = [
  'normal', 'lighten', 'screen', 'colorDodge', 'linearDodge', 'darken', 'multiply', 'colorBurn',
  'linearBurn', 'overlay', 'softLight', 'hardLight', 'difference', 'exclusion'
] as const

/** Mezcla una capa (premultiplicada) sobre lo acumulado con un modo de fusión. */
export const BLEND_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uLayer;
uniform int uMode;
out vec4 outColor;

vec3 blendOne(vec3 b, vec3 s) {
  if (uMode == 1) return max(b, s);
  if (uMode == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (uMode == 3) return min(vec3(1.0), b / max(1.0 - s, 0.001));
  if (uMode == 4) return min(vec3(1.0), b + s);
  if (uMode == 5) return min(b, s);
  if (uMode == 6) return b * s;
  if (uMode == 7) return 1.0 - min(vec3(1.0), (1.0 - b) / max(s, 0.001));
  if (uMode == 8) return max(vec3(0.0), b + s - 1.0);
  if (uMode == 9) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (uMode == 10) return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (sqrt(b) - b), step(0.5, s));
  if (uMode == 11) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (uMode == 12) return abs(b - s);
  if (uMode == 13) return b + s - 2.0 * b * s;
  return s;
}

void main() {
  vec4 base = texture(uBase, vUv);
  vec4 layer = texture(uLayer, vUv);
  vec3 b = base.a > 0.0 ? base.rgb / base.a : vec3(0.0);
  vec3 s = layer.a > 0.0 ? layer.rgb / layer.a : vec3(0.0);
  vec3 mixed = blendOne(b, s);
  // Fórmula estándar de composición con modo de fusión (W3C).
  vec3 rgb = (1.0 - base.a) * layer.rgb + (1.0 - layer.a) * base.rgb + layer.a * base.a * mixed;
  outColor = vec4(rgb, layer.a + base.a * (1.0 - layer.a));
}`

// Efectos de la pestaña Efectos: se aplican sobre todo lo que hay debajo.
// El orden define el índice del shader: lo nuevo va siempre al final.
export const EFFECTS = [
  { id: 'blur', label: 'Desenfoque', group: 'Desenfocar' },
  { id: 'shake', label: 'Sacudida', group: 'Cámara' },
  { id: 'glitch', label: 'Glitch', group: 'Distorsión' },
  { id: 'rgbsplit', label: 'Aberración RGB', group: 'Distorsión' },
  { id: 'zoompulse', label: 'Pulso de zoom', group: 'Cámara' },
  { id: 'flash', label: 'Destello', group: 'Luz' },
  { id: 'grain', label: 'Grano de película', group: 'Retro' },
  { id: 'vhs', label: 'VHS', group: 'Retro' },
  { id: 'bw', label: 'Blanco y negro', group: 'Básico' },
  { id: 'sepia', label: 'Sepia', group: 'Retro' },
  { id: 'vignette', label: 'Viñeta', group: 'Básico' },
  { id: 'lightleak', label: 'Fuga de luz', group: 'Luz' },
  { id: 'pixelate', label: 'Pixelar', group: 'Distorsión' },
  { id: 'mirror', label: 'Espejo', group: 'Básico' },
  { id: 'cinema', label: 'Barras de cine', group: 'Marcos' },
  { id: 'strobe', label: 'Estroboscopio', group: 'Fiesta' },
  { id: 'invert', label: 'Invertir', group: 'Básico' },
  { id: 'kaleido', label: 'Caleidoscopio', group: 'Fiesta' },
  { id: 'scanlines', label: 'Líneas de TV', group: 'Retro' },
  { id: 'zoomblur', label: 'Desenfoque radial', group: 'Desenfocar' },
  { id: 'heartbeat', label: 'Latido', group: 'Fiesta' },
  { id: 'dreamy', label: 'Ensueño', group: 'Luz' },
  { id: 'sparkle', label: 'Destellos', group: 'Fiesta' },
  { id: 'bokeh', label: 'Bokeh', group: 'Luz' },
  { id: 'hearts', label: 'Corazones', group: 'Fiesta' },
  { id: 'snow', label: 'Nieve', group: 'Fiesta' },
  { id: 'rain', label: 'Lluvia', group: 'Básico' },
  { id: 'confetti', label: 'Confeti', group: 'Fiesta' },
  { id: 'rainbow', label: 'Arcoíris', group: 'Luz' },
  { id: 'neon', label: 'Bordes neón', group: 'Distorsión' },
  { id: 'polaroid', label: 'Polaroid', group: 'Marcos' },
  { id: 'oldfilm', label: 'Película antigua', group: 'Retro' },
  { id: 'opening', label: 'Apertura', group: 'Intro y cierre' },
  { id: 'closing', label: 'Cierre en círculo', group: 'Intro y cierre' },
  { id: 'tvoff', label: 'TV apagada', group: 'Intro y cierre' },
  { id: 'amber', label: 'Luz ámbar', group: 'Luz' },
  { id: 'fisheye', label: 'Ojo de pez', group: 'Cámara' },
  { id: 'duotone', label: 'Duotono', group: 'Básico' },
  { id: 'blurin', label: 'Enfocar al inicio', group: 'Intro y cierre' },
  { id: 'whiteframe', label: 'Marco blanco', group: 'Marcos' }
] as const

export const EFFECT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform int uEffect;
uniform float uTime;
uniform float uIntensity;
uniform float uSpeed;
uniform vec2 uSize;
out vec4 outColor;

// Las texturas acumuladas están con la Y invertida.
vec4 S(vec2 uv) { return texture(uSrc, vec2(uv.x, 1.0 - uv.y)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 screenB(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
// Partículas en una cuadrícula que se desplaza: brillo 0..1 de la partícula en uv.
float particles(vec2 uv, float t, float cells, float speed, float size) {
  vec2 q = uv * vec2(uSize.x / uSize.y, 1.0) * cells;
  q.y -= t * speed;
  vec2 id = floor(q);
  vec2 f = fract(q);
  float r = hash(id);
  vec2 c = vec2(0.5 + 0.3 * sin(t * 1.3 + r * 6.28), 0.5 + 0.3 * (hash(id + 3.1) - 0.5));
  return (1.0 - smoothstep(size * 0.6, size, length(f - c))) * step(0.45, r);
}
float heartShape(vec2 p) {
  p.y -= 0.25;
  p.x = abs(p.x);
  float h = abs(atan(p.x, p.y) / 3.14159);
  float d = (13.0 * h - 22.0 * h * h + 10.0 * h * h * h) / (6.0 - 5.0 * h);
  return 1.0 - smoothstep(d * 0.42 - 0.02, d * 0.42 + 0.02, length(p));
}

void main() {
  vec2 uv = vUv;
  float I = uIntensity;
  float t = uTime * (0.3 + uSpeed * 2.0);
  vec4 c = S(uv);
  if (uEffect == 0) {
    vec4 sum = vec4(0.0);
    float r = I * 12.0;
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 2.39996;
      float d = sqrt(float(i) / 16.0) * r;
      sum += S(uv + vec2(cos(a), sin(a)) * d / uSize);
    }
    outColor = sum / 16.0; return;
  }
  if (uEffect == 1) {
    vec2 o = vec2(hash(vec2(floor(t * 24.0), 1.0)) - 0.5, hash(vec2(floor(t * 24.0), 2.0)) - 0.5) * 0.04 * I;
    outColor = S(clamp(0.5 + (uv - 0.5) * (1.0 - 0.04 * I) + o, 0.0, 1.0)); return;
  }
  if (uEffect == 2) {
    float block = floor(uv.y * 18.0);
    float n = hash(vec2(block, floor(t * 12.0)));
    float shift = n > 1.0 - I * 0.5 ? (hash(vec2(block, t)) - 0.5) * 0.15 * I : 0.0;
    vec2 u2 = vec2(uv.x + shift, uv.y);
    outColor = vec4(S(u2 + vec2(0.012 * I, 0.0)).r, S(u2).g, S(u2 - vec2(0.012 * I, 0.0)).b, 1.0); return;
  }
  if (uEffect == 3) {
    vec2 d = (uv - 0.5) * 0.02 * I;
    outColor = vec4(S(uv + d).r, c.g, S(uv - d).b, 1.0); return;
  }
  if (uEffect == 4) {
    float z = 1.0 + 0.08 * I * pow(abs(sin(t * 3.14159)), 4.0);
    outColor = S(0.5 + (uv - 0.5) / z); return;
  }
  if (uEffect == 5) {
    float f = pow(max(0.0, sin(t * 3.14159)), 16.0) * I;
    outColor = vec4(mix(c.rgb, vec3(1.0), f), 1.0); return;
  }
  if (uEffect == 6) {
    float g = hash(uv * uSize + floor(t * 24.0)) - 0.5;
    outColor = vec4(c.rgb + g * 0.18 * I, 1.0); return;
  }
  if (uEffect == 7) {
    float line = sin(uv.y * uSize.y * 1.5) * 0.04 * I;
    float wob = (hash(vec2(floor(uv.y * 60.0), floor(t * 10.0))) - 0.5) * 0.006 * I;
    vec2 u2 = uv + vec2(wob, 0.0);
    vec3 col = vec3(S(u2 + vec2(0.004 * I, 0.0)).r, S(u2).g, S(u2 - vec2(0.004 * I, 0.0)).b);
    col = mix(col, vec3(luma(col)), 0.25 * I) - line;
    outColor = vec4(col + (hash(uv * 400.0 + t) - 0.5) * 0.06 * I, 1.0); return;
  }
  if (uEffect == 8) { outColor = vec4(mix(c.rgb, vec3(luma(c.rgb)), I), 1.0); return; }
  if (uEffect == 9) {
    float l = luma(c.rgb);
    outColor = vec4(mix(c.rgb, vec3(l * 1.07, l * 0.74 + 0.04, l * 0.43), I), 1.0); return;
  }
  if (uEffect == 10) {
    float v = smoothstep(0.85, 0.25, length(uv - 0.5) * (1.1 + 0.15 * sin(t * 2.0)));
    outColor = vec4(c.rgb * mix(1.0, v, I), 1.0); return;
  }
  if (uEffect == 11) {
    vec2 p = vec2(0.15 + 0.25 * sin(t * 0.7), 0.2 + 0.2 * cos(t * 0.5));
    float d = length((uv - p) * vec2(uSize.x / uSize.y, 1.0));
    vec3 leak = vec3(1.0, 0.45, 0.15) * exp(-d * d * 4.0) + vec3(1.0, 0.2, 0.4) * exp(-pow(length(uv - vec2(1.0, 0.9)), 2.0) * 6.0) * 0.6;
    outColor = vec4(1.0 - (1.0 - c.rgb) * (1.0 - leak * I), 1.0); return;
  }
  if (uEffect == 12) {
    float cells = mix(uSize.y, 18.0, I);
    vec2 q = (floor(uv * cells * vec2(uSize.x / uSize.y, 1.0)) + 0.5) / (cells * vec2(uSize.x / uSize.y, 1.0));
    outColor = S(q); return;
  }
  if (uEffect == 13) { outColor = S(vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y)); return; }
  if (uEffect == 14) {
    float bar = 0.12 * I;
    outColor = (uv.y < bar || uv.y > 1.0 - bar) ? vec4(0.0, 0.0, 0.0, 1.0) : c; return;
  }
  if (uEffect == 15) {
    float on = step(0.5, fract(t * 4.0));
    outColor = vec4(mix(c.rgb, c.rgb * (0.3 + 0.7 * on) + vec3(0.25 * on), I), 1.0); return;
  }
  if (uEffect == 16) { outColor = vec4(mix(c.rgb, 1.0 - c.rgb, I), 1.0); return; }
  if (uEffect == 17) {
    vec2 p = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
    float a = atan(p.y, p.x) + t * 0.3;
    float r = length(p);
    float seg = 6.28318 / 6.0;
    a = mod(a, seg);
    a = abs(a - seg * 0.5);
    vec2 q = vec2(cos(a), sin(a)) * r / vec2(uSize.x / uSize.y, 1.0) + 0.5;
    outColor = mix(c, S(q), I); return;
  }
  if (uEffect == 18) {
    float s = 0.5 + 0.5 * sin(uv.y * uSize.y * 3.14159 * 0.5);
    outColor = vec4(c.rgb * (1.0 - 0.35 * I * s), 1.0); return;
  }
  if (uEffect == 19) {
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 16; i++) sum += S(0.5 + (uv - 0.5) * (1.0 - 0.012 * I * float(i)));
    outColor = sum / 16.0; return;
  }
  if (uEffect == 20) {
    float beat = pow(max(sin(t * 6.28318), 0.0), 8.0);
    vec2 u2 = 0.5 + (uv - 0.5) / (1.0 + 0.05 * I * beat);
    vec4 s = S(u2);
    outColor = vec4(s.rgb + vec3(0.25, 0.0, 0.05) * beat * I, 1.0); return;
  }
  if (uEffect == 21) {
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 2.39996;
      sum += S(uv + vec2(cos(a), sin(a)) * sqrt(float(i) / 12.0) * 10.0 / uSize);
    }
    vec3 glow = sum.rgb / 12.0;
    outColor = vec4(mix(c.rgb, 1.0 - (1.0 - c.rgb) * (1.0 - glow * 0.6), I), 1.0); return;
  }
  if (uEffect == 22) { // destellos que titilan
    float sum = 0.0;
    for (int i = 0; i < 3; i++) {
      vec2 q = uv * vec2(uSize.x / uSize.y, 1.0) * (6.0 + float(i) * 5.0);
      vec2 id = floor(q);
      vec2 f = fract(q) - 0.5;
      float r = hash(id + float(i) * 7.0);
      float tw = pow(max(0.0, sin(t * 3.0 + r * 40.0)), 8.0) * step(0.7, r);
      float star = max(0.0, 1.0 - length(f) * 7.0)
        + max(0.0, 1.0 - abs(f.x) * 40.0) * max(0.0, 1.0 - abs(f.y) * 4.0)
        + max(0.0, 1.0 - abs(f.y) * 40.0) * max(0.0, 1.0 - abs(f.x) * 4.0);
      sum += star * tw;
    }
    outColor = vec4(screenB(c.rgb, vec3(1.0, 0.95, 0.8) * sum * I), 1.0); return;
  }
  if (uEffect == 23) { // bokeh
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      vec2 pos = vec2(hash(vec2(fi, 1.0)), fract(hash(vec2(fi, 2.0)) - t * 0.03 * (0.5 + hash(vec2(fi, 4.0)))));
      float rad = 0.04 + 0.08 * hash(vec2(fi, 3.0));
      float d = length((uv - pos) * vec2(uSize.x / uSize.y, 1.0));
      vec3 col = mix(vec3(1.0, 0.75, 0.4), vec3(1.0, 0.45, 0.7), hash(vec2(fi, 5.0)));
      acc += col * (1.0 - smoothstep(rad * 0.85, rad, d)) * 0.35;
    }
    outColor = vec4(screenB(c.rgb, acc * I), 1.0); return;
  }
  if (uEffect == 24) { // corazones que suben
    vec2 q = uv * vec2(uSize.x / uSize.y, 1.0) * 5.0;
    q.y += t * 0.6;
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float r = hash(id);
    f.x += 0.15 * sin(t * 2.0 + r * 6.0);
    float h = heartShape(vec2(f.x, -f.y) * 2.6) * step(0.55, r);
    outColor = vec4(mix(c.rgb, vec3(1.0, 0.3, 0.45), h * I), 1.0); return;
  }
  if (uEffect == 25) { // nieve
    float sn = particles(uv, t * 0.5, 14.0, -1.0, 0.12) + particles(uv, t * 0.35, 24.0, -1.0, 0.1) * 0.6;
    outColor = vec4(mix(c.rgb, vec3(1.0), clamp(sn, 0.0, 1.0) * I), 1.0); return;
  }
  if (uEffect == 26) { // lluvia
    vec2 q = uv * vec2(80.0, 3.0);
    q.y -= t * 6.0;
    q.x += q.y * 0.15;
    float r = hash(floor(q));
    float drop = step(0.93, r) * smoothstep(0.0, 0.8, fract(q.y)) * (1.0 - smoothstep(0.0, 0.08, abs(fract(q.x) - 0.5)));
    outColor = vec4(mix(c.rgb * (1.0 - 0.15 * I), vec3(0.8, 0.85, 0.9), drop * 0.6 * I), 1.0); return;
  }
  if (uEffect == 27) { // confeti
    vec2 q = uv * vec2(uSize.x / uSize.y, 1.0) * 12.0;
    q.y -= t * 1.4;
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float r = hash(id);
    float ang = t * 4.0 * (r - 0.5) + r * 6.28;
    f = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * f;
    float piece = step(abs(f.x), 0.18) * step(abs(f.y), 0.07 + 0.06 * abs(sin(t * 3.0 + r * 9.0))) * step(0.6, r);
    vec3 col = 0.5 + 0.5 * cos(6.28 * (r * 3.0 + vec3(0.0, 0.33, 0.67)));
    outColor = vec4(mix(c.rgb, col, piece * I), 1.0); return;
  }
  if (uEffect == 28) { // arcoíris
    vec3 rb = 0.5 + 0.5 * cos(6.28 * ((uv.x + uv.y) * 0.7 - t * 0.2 + vec3(0.0, 0.33, 0.67)));
    outColor = vec4(mix(c.rgb, screenB(c.rgb, rb * 0.55), I), 1.0); return;
  }
  if (uEffect == 29) { // bordes neón
    vec2 px = 1.0 / uSize;
    float gx = luma(S(uv + vec2(px.x, 0.0)).rgb) - luma(S(uv - vec2(px.x, 0.0)).rgb);
    float gy = luma(S(uv + vec2(0.0, px.y)).rgb) - luma(S(uv - vec2(0.0, px.y)).rgb);
    float e = clamp(length(vec2(gx, gy)) * 6.0, 0.0, 1.0);
    vec3 neonCol = 0.5 + 0.5 * cos(6.28 * (t * 0.3 + uv.y + vec3(0.0, 0.33, 0.67)));
    outColor = vec4(mix(c.rgb, c.rgb * 0.35 + neonCol * e * 1.4, I), 1.0); return;
  }
  if (uEffect == 30) { // polaroid
    float m = 0.05 * max(I, 0.2);
    vec2 inner = (uv - vec2(m, m)) / vec2(1.0 - 2.0 * m, 1.0 - m * 3.5);
    bool inPhoto = all(greaterThanEqual(inner, vec2(0.0))) && all(lessThanEqual(inner, vec2(1.0)));
    vec3 photo = S(clamp(inner, 0.0, 1.0)).rgb;
    photo = mix(photo, vec3(luma(photo)) * vec3(1.05, 1.0, 0.9), 0.15);
    outColor = vec4(inPhoto ? photo : vec3(0.96, 0.95, 0.92), 1.0); return;
  }
  if (uEffect == 31) { // película antigua
    float l = luma(c.rgb);
    vec3 sep = vec3(l * 1.05, l * 0.85, l * 0.6);
    float scratch = step(0.995, hash(vec2(floor(uv.x * 300.0), floor(t * 18.0)))) * 0.5;
    float flick = 0.92 + 0.08 * hash(vec2(floor(t * 18.0), 3.0));
    float grain = (hash(uv * uSize + floor(t * 24.0)) - 0.5) * 0.12;
    float vig = smoothstep(0.9, 0.3, length(uv - 0.5));
    vec3 old = (sep * flick + grain + scratch) * mix(1.0, vig, 0.7);
    outColor = vec4(mix(c.rgb, old, I), 1.0); return;
  }
  if (uEffect == 32) { // apertura: barras que se abren
    float open = smoothstep(0.0, 1.0, uTime / max(0.2, 1.2 - uSpeed));
    float bar = 0.5 * (1.0 - open);
    outColor = (uv.y < bar || uv.y > 1.0 - bar) ? vec4(0.0, 0.0, 0.0, 1.0) : c; return;
  }
  if (uEffect == 33) { // cierre en círculo
    float k = smoothstep(0.0, 1.0, uTime / max(0.2, 1.2 - uSpeed));
    float r = length((uv - 0.5) * vec2(uSize.x / uSize.y, 1.0));
    outColor = r > (1.0 - k) ? vec4(0.0, 0.0, 0.0, 1.0) : c; return;
  }
  if (uEffect == 34) { // TV apagada
    float k = smoothstep(0.0, 1.0, uTime / max(0.2, 1.0 - uSpeed * 0.6));
    float hgt = max(0.004, 1.0 - k * 1.1);
    float wid = k > 0.9 ? max(0.0, 1.0 - (k - 0.9) * 10.0) : 1.0;
    vec2 q = vec2(0.5 + (uv.x - 0.5) / max(wid, 0.001), 0.5 + (uv.y - 0.5) / hgt);
    bool inside = abs(uv.y - 0.5) < hgt * 0.5 && abs(uv.x - 0.5) < wid * 0.5;
    outColor = vec4(inside ? mix(S(clamp(q, 0.0, 1.0)).rgb, vec3(1.0), k) : vec3(0.0), 1.0); return;
  }
  if (uEffect == 35) { // luz ámbar
    vec3 warm = c.rgb * vec3(1.12, 0.98, 0.78) + vec3(0.06, 0.03, 0.0);
    float spot = exp(-pow(length(uv - vec2(0.8, 0.15)), 2.0) * 5.0);
    outColor = vec4(mix(c.rgb, screenB(warm, vec3(1.0, 0.6, 0.2) * spot * 0.6), I), 1.0); return;
  }
  if (uEffect == 36) { // ojo de pez
    vec2 asp = vec2(uSize.x / uSize.y, 1.0);
    vec2 p = (uv - 0.5) * asp;
    float r = length(p);
    vec2 q = p * (1.0 - I * 0.45 * (0.6 - r * r)) / asp + 0.5;
    outColor = S(clamp(q, 0.0, 1.0)); return;
  }
  if (uEffect == 37) { // duotono
    float l = luma(c.rgb);
    vec3 duo = mix(vec3(0.12, 0.05, 0.35), vec3(1.0, 0.55, 0.45), l);
    outColor = vec4(mix(c.rgb, duo, I), 1.0); return;
  }
  if (uEffect == 38) { // enfocar al inicio
    float k = 1.0 - smoothstep(0.0, 1.0, uTime / max(0.2, 1.2 - uSpeed));
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 2.39996;
      sum += S(uv + vec2(cos(a), sin(a)) * sqrt(float(i) / 16.0) * 18.0 * k * I / uSize);
    }
    outColor = sum / 16.0; return;
  }
  if (uEffect == 39) { // marco blanco
    float m = 0.04 * max(I, 0.2);
    vec2 d = abs(uv - 0.5) - (0.5 - m);
    bool inside = max(d.x, d.y) < 0.0;
    outColor = inside ? S(0.5 + (uv - 0.5) / (1.0 - 2.0 * m)) : vec4(1.0); return;
  }
  outColor = c;
}`

// Transiciones. Las 16 primeras son el port de xfade (FFmpeg); el resto, propias.
export const TRANSITION_KINDS = [
  'fade', 'dissolve', 'fadeblack', 'fadewhite', 'slideleft', 'slideright', 'slideup', 'slidedown',
  'wipeleft', 'wiperight', 'circleopen', 'circleclose', 'zoomin', 'radial', 'pixelize', 'smoothleft',
  'blur', 'zoomblur', 'spin', 'glitch', 'flash', 'swirl', 'cube', 'pagecurl', 'doorway', 'ripple',
  'luma', 'directionalwarp', 'crosswarp', 'squeeze', 'morph', 'burn', 'colorphase', 'windowslice', 'mosaic', 'heart',
  'whipleft', 'whipright', 'zoomout', 'spinblur', 'camshake', 'lens', 'lightleak', 'burnflash', 'lightbeam', 'lightning', 'glowmix', 'push', 'bounce', 'star', 'gridflip', 'flip3d', 'liquid', 'gridshift', 'signal', 'doubleexposure', 'rgbshift', 'curtain'
] as const

export const TRANSITION_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uP;
uniform int uKind;
uniform vec2 uSize;
out vec4 outColor;

const float PI = 3.14159265;
// Las capas están guardadas con la Y invertida; x,y en píxeles con y=0 arriba.
vec4 A(vec2 px) { return texture(uA, vec2(px.x / uSize.x, 1.0 - px.y / uSize.y)); }
vec4 B(vec2 px) { return texture(uB, vec2(px.x / uSize.x, 1.0 - px.y / uSize.y)); }
vec4 Au(vec2 uv) { return texture(uA, vec2(uv.x, 1.0 - uv.y)); }
vec4 Bu(vec2 uv) { return texture(uB, vec2(uv.x, 1.0 - uv.y)); }
vec4 cmix(vec4 a, vec4 b, float m) { return a * m + b * (1.0 - m); }
float frand(vec2 p) { float r = sin(p.x * 12.9898 + p.y * 78.233) * 43758.545; return r - floor(r); }
bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }
vec4 Ab(vec2 uv) { return inside(uv) ? Au(uv) : vec4(0.0, 0.0, 0.0, 1.0); }
vec4 Bb(vec2 uv) { return inside(uv) ? Bu(uv) : vec4(0.0, 0.0, 0.0, 1.0); }
// Desenfoque de movimiento en una dirección (en uv).
vec4 blurA(vec2 uv, vec2 dir) { vec4 s = vec4(0.0); for (int i = 0; i < 12; i++) s += Ab(uv + dir * (float(i) / 11.0 - 0.5)); return s / 12.0; }
vec4 blurB(vec2 uv, vec2 dir) { vec4 s = vec4(0.0); for (int i = 0; i < 12; i++) s += Bb(uv + dir * (float(i) / 11.0 - 0.5)); return s / 12.0; }
vec3 scr(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
float ease(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }

void main() {
  float p = clamp(uP, 0.0, 1.0);
  float P = 1.0 - p;   // progreso estilo xfade (1 → 0)
  float W = uSize.x;
  float H = uSize.y;
  vec2 px = floor(vUv * uSize) + 0.5;
  vec2 uv = vUv;
  float x = px.x;
  float y = px.y;
  vec4 a = A(px);
  vec4 b = B(px);
  vec4 black = vec4(0.0, 0.0, 0.0, 1.0);
  vec4 white = vec4(1.0);
  float asp = W / H;

  if (uKind == 0) { outColor = cmix(a, b, P); return; }
  if (uKind == 1) { float sm = frand(floor(px)) * 2.0 + P * 2.0 - 1.5; outColor = sm >= 0.5 ? a : b; return; }
  if (uKind == 2 || uKind == 3) {
    vec4 bg = uKind == 2 ? black : white;
    outColor = cmix(cmix(a, bg, smoothstep(0.8, 1.0, P)), cmix(bg, b, smoothstep(0.2, 1.0, P)), P);
    return;
  }
  if (uKind == 4 || uKind == 5) {
    float zx = x + (uKind == 4 ? -P * W : P * W);
    float zz = mod(zx, W);
    outColor = (zx >= 0.0 && zx < W) ? B(vec2(zz, y)) : A(vec2(zz, y));
    return;
  }
  if (uKind == 6 || uKind == 7) {
    float zy = y + (uKind == 6 ? -P * H : P * H);
    float zz = mod(zy, H);
    outColor = (zy >= 0.0 && zy < H) ? B(vec2(x, zz)) : A(vec2(x, zz));
    return;
  }
  if (uKind == 8) { outColor = x > W * P ? b : a; return; }
  if (uKind == 9) { outColor = x > W * (1.0 - P) ? a : b; return; }
  float z = length(vec2(W, H) * 0.5);
  float r = length(px - vec2(W, H) * 0.5) / z;
  if (uKind == 10) { outColor = cmix(a, b, smoothstep(0.0, 1.0, r + (P - 0.5) * 3.0)); return; }
  if (uKind == 11) { outColor = cmix(b, a, smoothstep(0.0, 1.0, r + (0.5 - P) * 3.0)); return; }
  if (uKind == 12) {
    float zf = smoothstep(0.5, 1.0, P);
    vec2 zuv = 0.5 + (px / uSize - 0.5) * zf;
    vec4 zv = A(ceil(zuv * (uSize - 1.0)) + 0.5);
    outColor = cmix(zv, b, smoothstep(0.0, 0.5, P));
    return;
  }
  if (uKind == 13) {
    float sm = atan(x - W * 0.5, y - H * 0.5) - (P - 0.5) * (PI * 2.5);
    outColor = cmix(b, a, smoothstep(0.0, 1.0, sm));
    return;
  }
  if (uKind == 14) {
    float d = min(P, 1.0 - P);
    float dist = ceil(d * 50.0) / 50.0;
    float sq = 2.0 * dist * min(W, H) / 20.0;
    vec2 s = dist > 0.0 ? min((floor(px / sq) + 0.5) * sq, uSize - 1.0) : px;
    outColor = cmix(A(s), B(s), P);
    return;
  }
  if (uKind == 15) { outColor = cmix(b, a, smoothstep(0.0, 1.0, 1.0 + x / W - P * 2.0)); return; }

  // --- Propias -------------------------------------------------------------------
  if (uKind == 16) { // desenfoque cruzado
    float k = sin(p * PI) * 14.0;
    vec4 sa = vec4(0.0), sb = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      float ang = float(i) * 2.39996;
      vec2 o = vec2(cos(ang), sin(ang)) * sqrt(float(i) / 12.0) * k / uSize;
      sa += Au(uv + o); sb += Bu(uv + o);
    }
    outColor = mix(sa / 12.0, sb / 12.0, smoothstep(0.3, 0.7, p)); return;
  }
  if (uKind == 17) { // zoom con desenfoque radial
    float k = sin(p * PI) * 0.25;
    vec4 s = vec4(0.0);
    for (int i = 0; i < 14; i++) {
      vec2 q = 0.5 + (uv - 0.5) * (1.0 - k * float(i) / 14.0);
      s += p < 0.5 ? Au(q) : Bu(q);
    }
    outColor = s / 14.0; return;
  }
  if (uKind == 18) { // giro
    float ang = p * PI * 2.0;
    float sc = 1.0 + sin(p * PI) * 1.5;
    vec2 q = (uv - 0.5) * vec2(asp, 1.0);
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q * sc;
    q = q / vec2(asp, 1.0) + 0.5;
    vec4 ca = inside(q) ? Au(q) : black;
    vec4 cb = inside(q) ? Bu(q) : black;
    outColor = mix(ca, cb, smoothstep(0.4, 0.6, p)); return;
  }
  if (uKind == 19) { // glitch
    float strength = sin(p * PI);
    float block = floor(uv.y * 24.0);
    float n = frand(vec2(block, floor(p * 30.0)));
    vec2 q = uv + vec2((n - 0.5) * 0.2 * strength * step(0.6, n), 0.0);
    vec4 src = p < 0.5 ? Au(q) : Bu(q);
    vec4 r2 = p < 0.5 ? Au(q + vec2(0.02 * strength, 0.0)) : Bu(q + vec2(0.02 * strength, 0.0));
    outColor = vec4(r2.r, src.g, (p < 0.5 ? Au(q - vec2(0.02 * strength, 0.0)) : Bu(q - vec2(0.02 * strength, 0.0))).b, 1.0); return;
  }
  if (uKind == 20) { // destello
    float f = pow(sin(p * PI), 3.0);
    outColor = mix(mix(a, b, step(0.5, p)), white, f); return;
  }
  if (uKind == 21) { // remolino
    vec2 q = (uv - 0.5) * vec2(asp, 1.0);
    float rr = length(q);
    float ang = sin(p * PI) * 6.0 * (1.0 - smoothstep(0.0, 0.8, rr));
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
    q = q / vec2(asp, 1.0) + 0.5;
    outColor = mix(Au(q), Bu(q), smoothstep(0.35, 0.65, p)); return;
  }
  if (uKind == 22) { // cubo
    float persp = 0.7;
    float edge = 1.0 - p;
    if (uv.x < edge) {
      float u = uv.x / edge;
      float sy = 1.0 - persp * 0.3 * p * u;
      vec2 q = vec2(p + u * (1.0 - p), 0.5 + (uv.y - 0.5) / sy);
      q.x = u;
      outColor = inside(q) ? mix(Au(q), black, p * 0.5) : black;
    } else {
      float u = (uv.x - edge) / max(p, 0.0001);
      float sy = 1.0 - persp * 0.3 * (1.0 - p) * (1.0 - u);
      vec2 q = vec2(u, 0.5 + (uv.y - 0.5) / sy);
      outColor = inside(q) ? mix(Bu(q), black, (1.0 - p) * 0.5) : black;
    }
    return;
  }
  if (uKind == 23) { // pasar página
    float fold = 1.0 - p * 1.2;
    float d = uv.x + uv.y * 0.2 - fold;
    if (d < 0.0) { outColor = a; return; }
    if (d < 0.12) {
      vec2 q = vec2(fold - d - uv.y * 0.2, uv.y);
      outColor = inside(q) ? mix(Au(q), white, 0.5) * (0.7 + d * 2.0) : b;
      return;
    }
    outColor = b; return;
  }
  if (uKind == 24) { // puertas
    float open = p;
    if (abs(uv.x - 0.5) < open * 0.5) { outColor = Bu(0.5 + (uv - 0.5) * (1.2 - 0.2 * p)); return; }
    float side = uv.x < 0.5 ? -1.0 : 1.0;
    vec2 q = vec2(uv.x - side * open * 0.5, uv.y);
    outColor = inside(q) ? Au(q) * (1.0 - p * 0.5) : black; return;
  }
  if (uKind == 25) { // ondas
    vec2 q = (uv - 0.5) * vec2(asp, 1.0);
    float d = length(q);
    vec2 off = normalize(q + 1e-5) * sin(d * 40.0 - p * 30.0) * 0.03 * sin(p * PI);
    outColor = mix(Au(uv + off), Bu(uv + off), smoothstep(0.3, 0.7, p)); return;
  }
  if (uKind == 26) { // por luminancia
    float l = dot(Bu(uv).rgb, vec3(0.2126, 0.7152, 0.0722));
    outColor = mix(a, b, smoothstep(l - 0.1, l + 0.1, p * 1.2 - 0.1)); return;
  }
  if (uKind == 27) { // deformación direccional
    vec2 dir = vec2(-1.0, 1.0);
    float m = smoothstep(-0.5, 0.0, dot(uv - 0.5, normalize(dir)) * 0.5 - (p * 1.5 - 0.75));
    outColor = mix(Au((uv - 0.5) * (1.0 - m) + 0.5), Bu((uv - 0.5) * m + 0.5), m); return;
  }
  if (uKind == 28) { // deformación cruzada
    float m = smoothstep(0.0, 1.0, p * 2.0 + uv.x - 1.0);
    outColor = mix(Au((uv - 0.5) * (1.0 - m) + 0.5), Bu((uv - 0.5) * m + 0.5), m); return;
  }
  if (uKind == 29) { // apretar
    float sc = 1.0 - sin(p * PI) * 0.9;
    vec2 q = vec2(uv.x, 0.5 + (uv.y - 0.5) / sc);
    outColor = inside(q) ? (p < 0.5 ? Au(q) : Bu(q)) : black; return;
  }
  if (uKind == 30) { // transformar
    vec4 ca = Au(uv), cb = Bu(uv);
    vec2 off = (ca.rg - cb.rg) * 0.2 * sin(p * PI);
    outColor = mix(Au(uv + off * p), Bu(uv - off * (1.0 - p)), p); return;
  }
  if (uKind == 31) { // quemar
    float n = frand(floor(uv * vec2(80.0 * asp, 80.0)));
    float edge = p * 1.3 - 0.15;
    float m = smoothstep(edge - 0.05, edge + 0.05, n * 0.6 + uv.x * 0.4);
    vec4 burn = vec4(1.0, 0.45, 0.1, 1.0) * (1.0 - abs(m - 0.5) * 2.0) * 1.5;
    outColor = mix(b, a, m) + burn * step(0.02, m) * step(m, 0.98); return;
  }
  if (uKind == 32) { // fase de color
    vec4 fromStep = vec4(0.0, 0.2, 0.4, 0.0), toStep = vec4(0.6, 0.8, 1.0, 1.0);
    outColor = mix(a, b, smoothstep(fromStep, toStep, vec4(p))); return;
  }
  if (uKind == 33) { // persianas
    float count = 10.0;
    float pr = smoothstep(-0.5, 0.0, uv.x - p * 1.5);
    float s = step(pr, fract(count * uv.x));
    outColor = mix(a, b, s); return;
  }
  if (uKind == 34) { // mosaico
    float cells = 12.0;
    vec2 cell = floor(uv * vec2(cells * asp, cells));
    float n = frand(cell);
    outColor = n < p ? b : a; return;
  }
  if (uKind == 35) { // corazón
    vec2 o = (uv - vec2(0.5, 0.4)) * vec2(asp, 1.0);
    float rr = p * 1.6;
    o.y = -o.y;
    float hx = o.x * o.x + pow(o.y - sqrt(abs(o.x)) * 0.5, 2.0);
    outColor = hx < rr * rr * 0.25 ? b : a; return;
  }
  if (uKind == 36 || uKind == 37) { // tirar a la izquierda / derecha (latigazo de cámara)
    float dir = uKind == 36 ? 1.0 : -1.0;
    float e = ease(p);
    float sp = sin(p * PI) * 0.35;
    vec2 off = vec2(dir * e, 0.0);
    outColor = p < 0.5 ? blurA(uv + off * 1.0, vec2(sp, 0.0)) : blurB(uv + off - vec2(dir, 0.0), vec2(sp, 0.0)); return;
  }
  if (uKind == 38) { // alejar
    float sc = p < 0.5 ? 1.0 - p * 0.9 : 1.0 + (1.0 - p) * 1.4;
    vec2 q = 0.5 + (uv - 0.5) / sc;
    vec2 d = (uv - 0.5) * sin(p * PI) * 0.15;
    outColor = p < 0.5 ? blurA(q, d) : blurB(q, d); return;
  }
  if (uKind == 39) { // rotación con desenfoque
    float ang = (p < 0.5 ? p : p - 1.0) * PI * 1.2;
    vec2 c = (uv - 0.5) * vec2(asp, 1.0);
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 10; i++) {
      float a2 = ang + sin(p * PI) * 0.25 * (float(i) / 9.0 - 0.5);
      vec2 q = mat2(cos(a2), -sin(a2), sin(a2), cos(a2)) * c / vec2(asp, 1.0) + 0.5;
      acc += p < 0.5 ? Ab(q) : Bb(q);
    }
    outColor = acc / 10.0; return;
  }
  if (uKind == 40) { // sacudida de cámara
    float k = sin(p * PI);
    vec2 o = vec2(frand(vec2(floor(p * 40.0), 1.0)) - 0.5, frand(vec2(floor(p * 40.0), 2.0)) - 0.5) * 0.08 * k;
    vec2 q = 0.5 + (uv - 0.5) * (1.0 - 0.06 * k) + o;
    outColor = mix(p < 0.5 ? Ab(q) : Bb(q), white, pow(k, 6.0) * 0.6); return;
  }
  if (uKind == 41) { // lente
    vec2 c = (uv - 0.5) * vec2(asp, 1.0);
    float k = sin(p * PI);
    float r = length(c);
    vec2 q = c * (1.0 - k * 0.6 * (0.8 - r * r)) / vec2(asp, 1.0) + 0.5;
    outColor = mix(Ab(q), Bb(q), smoothstep(0.4, 0.6, p)); return;
  }
  if (uKind == 42) { // fuga de luz
    float k = sin(p * PI);
    vec2 c = vec2(mix(-0.3, 1.3, p), 0.3);
    float g = exp(-pow(length((uv - c) * vec2(asp * 0.6, 1.0)), 2.0) * 3.0);
    vec3 leak = vec3(1.0, 0.55, 0.2) * g * 1.6 * k + vec3(1.0, 0.85, 0.6) * k * 0.35;
    vec4 base = mix(a, b, smoothstep(0.45, 0.55, p));
    outColor = vec4(scr(base.rgb, leak), 1.0); return;
  }
  if (uKind == 43) { // destello quemado
    float k = sin(p * PI);
    vec4 base = mix(a, b, smoothstep(0.45, 0.55, p));
    vec3 burn = mix(vec3(1.0, 0.45, 0.1), vec3(1.0), smoothstep(0.6, 1.0, k));
    outColor = vec4(mix(base.rgb, scr(base.rgb, burn), pow(k, 1.5)), 1.0); return;
  }
  if (uKind == 44) { // haz de luz diagonal
    float pos = mix(-0.4, 1.4, p);
    float d = abs((uv.x + uv.y * 0.5) / 1.5 - pos * 0.85);
    float beam = exp(-d * d * 120.0) * 1.5 + exp(-d * d * 12.0) * 0.4;
    vec4 base = (uv.x + uv.y * 0.5) / 1.5 < pos * 0.85 ? b : a;
    outColor = vec4(scr(base.rgb, vec3(1.0, 0.95, 0.85) * beam), 1.0); return;
  }
  if (uKind == 45) { // rayo potente
    float f1 = step(0.25, p) * step(p, 0.32);
    float f2 = step(0.45, p) * step(p, 0.55);
    float f3 = step(0.62, p) * step(p, 0.66);
    vec4 base = p < 0.5 ? a : b;
    float flash = max(max(f1, f2), f3 * 0.7);
    vec3 col = mix(base.rgb, vec3(0.85, 0.9, 1.0), flash);
    outColor = vec4(f2 > 0.0 ? 1.0 - base.rgb * 0.3 : col, 1.0); return;
  }
  if (uKind == 46) { // brillo
    float k = sin(p * PI);
    vec4 sa = vec4(0.0), sb = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      float ang = float(i) * 2.39996;
      vec2 o = vec2(cos(ang), sin(ang)) * sqrt(float(i) / 12.0) * 0.03 * k;
      sa += Au(uv + o);
      sb += Bu(uv + o);
    }
    vec4 base = mix(a, b, p);
    vec4 bloom = mix(sa, sb, p) / 12.0;
    outColor = vec4(scr(base.rgb, bloom.rgb * k * 0.9), 1.0); return;
  }
  if (uKind == 47) { // empujar
    float e = ease(p);
    vec2 qa = uv + vec2(e, 0.0);
    vec2 qb = 0.5 + (uv - vec2(e - 1.0, 0.0) - 0.5) / (0.9 + 0.1 * e);
    outColor = uv.x < 1.0 - e ? Ab(qa) * (1.0 - 0.4 * e) : Bb(uv - vec2(1.0 - e, 0.0)); return;
  }
  if (uKind == 48) { // deslizar con rebote
    float e = 1.0 - pow(1.0 - p, 3.0) * cos(p * PI * 2.5);
    float x = 1.0 - e;
    outColor = uv.x >= x ? Bb(uv - vec2(x, 0.0)) : a; return;
  }
  if (uKind == 49) { // estrella
    vec2 o = (uv - 0.5) * vec2(asp, 1.0);
    float ang = atan(o.y, o.x) + PI * 0.5;
    float rr = length(o);
    float star = 0.6 + 0.4 * cos(ang * 5.0);
    outColor = rr < p * 1.4 * (0.55 + 0.45 * star) ? b : a; return;
  }
  if (uKind == 50) { // mosaicos que giran
    vec2 cells = vec2(6.0 * asp, 6.0);
    vec2 id = floor(uv * cells);
    float delay = (id.x + id.y) / (cells.x + cells.y);
    float lp = clamp((p - delay * 0.5) * 2.0, 0.0, 1.0);
    vec2 f = fract(uv * cells) - 0.5;
    float sx = abs(cos(lp * PI));
    vec2 q = (id + 0.5 + vec2(f.x / max(sx, 0.001), f.y)) / cells;
    bool show = abs(f.x) < sx * 0.5;
    outColor = show ? (lp < 0.5 ? Ab(q) : Bb(q)) : black; return;
  }
  if (uKind == 51) { // volteo 3D
    float ang = p * PI;
    float sx = abs(cos(ang));
    float persp = 1.0 + sin(ang) * 0.3 * (uv.x - 0.5) * (p < 0.5 ? 1.0 : -1.0);
    vec2 q = vec2(0.5 + (uv.x - 0.5) / max(sx, 0.001), 0.5 + (uv.y - 0.5) * persp);
    bool vis = abs(uv.x - 0.5) < sx * 0.5;
    outColor = vis ? (p < 0.5 ? Ab(q) : Bb(q)) : black; return;
  }
  if (uKind == 52) { // difusión líquida
    float n = sin(uv.x * 12.0 + p * 6.0) * 0.5 + sin(uv.y * 9.0 - p * 5.0) * 0.5;
    vec2 d = vec2(n, -n) * 0.04 * sin(p * PI);
    float m = smoothstep(-0.15, 0.15, p * 1.4 - 0.2 + n * 0.15 - uv.y * 0.2);
    outColor = mix(Ab(uv + d), Bb(uv - d), m); return;
  }
  if (uKind == 53) { // delirio de cuadrícula
    float cellsN = 8.0;
    vec2 id = floor(uv * cellsN);
    float r = frand(id);
    vec2 shift = (vec2(frand(id + 1.3), frand(id + 2.7)) - 0.5) * 0.3 * sin(p * PI);
    vec2 q = uv + shift;
    outColor = (p + (r - 0.5) * 0.4) < 0.5 ? Ab(q) : Bb(q); return;
  }
  if (uKind == 54) { // distorsión de señal
    float k = sin(p * PI);
    float line = floor(uv.y * 60.0);
    float n = frand(vec2(line, floor(p * 24.0)));
    float shift = (n - 0.5) * 0.25 * k * step(0.5, n);
    vec2 q = vec2(uv.x + shift, uv.y);
    vec4 src = p < 0.5 ? Ab(q) : Bb(q);
    vec4 rch = p < 0.5 ? Ab(q + vec2(0.015 * k, 0.0)) : Bb(q + vec2(0.015 * k, 0.0));
    vec4 bch = p < 0.5 ? Ab(q - vec2(0.015 * k, 0.0)) : Bb(q - vec2(0.015 * k, 0.0));
    float noiseLine = step(0.97, frand(vec2(floor(uv.y * 200.0), floor(p * 30.0)))) * k;
    outColor = vec4(vec3(rch.r, src.g, bch.b) + noiseLine * 0.5, 1.0); return;
  }
  if (uKind == 55) { // doble exposición
    float k = sin(p * PI);
    vec3 ex = scr(a.rgb, b.rgb);
    outColor = vec4(mix(mix(a.rgb, b.rgb, p), ex, k * 0.85), 1.0); return;
  }
  if (uKind == 56) { // cambio RGB
    float k = sin(p * PI) * 0.06;
    vec4 base = mix(a, b, smoothstep(0.4, 0.6, p));
    float r = mix(Au(uv + vec2(k, 0.0)).r, Bu(uv + vec2(k, 0.0)).r, smoothstep(0.4, 0.6, p));
    float bl = mix(Au(uv - vec2(k, 0.0)).b, Bu(uv - vec2(k, 0.0)).b, smoothstep(0.4, 0.6, p));
    outColor = vec4(r, base.g, bl, 1.0); return;
  }
  if (uKind == 57) { // cortina
    float e = ease(p);
    float fold = sin(uv.x * 60.0) * 0.08;
    vec3 cloth = vec3(0.45, 0.04, 0.08) * (0.8 + fold);
    if (p < 0.5) { float c2 = 0.5 * ease(p * 2.0); outColor = (uv.x < c2 || uv.x > 1.0 - c2) ? vec4(cloth, 1.0) : a; return; }
    float c3 = 0.5 * (1.0 - ease((p - 0.5) * 2.0));
    outColor = (uv.x < c3 || uv.x > 1.0 - c3) ? vec4(cloth, 1.0) : b; return;
  }
  outColor = mix(a, b, p);
}`

/** Empaqueta la imagen final en YUV 4:2:0 BT.709 (rango limitado), 4 muestras por píxel RGBA. */
export const YUV_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSize;     // tamaño de la imagen
uniform int uPlane;     // 0 = Y, 1 = U, 2 = V
out vec4 outColor;

// Fila de la imagen (0 = arriba) en la textura acumulada (guardada con la Y invertida).
vec3 px(float x, float y) { return texture(uSrc, vec2((x + 0.5) / uSize.x, 1.0 - (y + 0.5) / uSize.y)).rgb; }

float Y(vec3 c) { return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0; }
float U(vec3 c) { return (128.0 + 224.0 * dot(c, vec3(-0.114572, -0.385428, 0.5))) / 255.0; }
float V(vec3 c) { return (128.0 + 224.0 * dot(c, vec3(0.5, -0.454153, -0.045847))) / 255.0; }

void main() {
  // gl_FragCoord.y crece hacia arriba; readPixels devuelve primero la fila 0, que debe ser la de arriba.
  float row = floor(gl_FragCoord.y);
  float col = floor(gl_FragCoord.x);
  vec4 o;
  if (uPlane == 0) {
    for (int k = 0; k < 4; k++) o[k] = Y(px(col * 4.0 + float(k), row));
  } else {
    for (int k = 0; k < 4; k++) {
      float cx = (col * 4.0 + float(k)) * 2.0;
      float cy = row * 2.0;
      vec3 c = (px(cx, cy) + px(cx + 1.0, cy) + px(cx, cy + 1.0) + px(cx + 1.0, cy + 1.0)) * 0.25;
      o[k] = uPlane == 1 ? U(c) : V(c);
    }
  }
  outColor = o;
}`

/** Capa de ajuste: LUT y ajustes sobre todo lo que tiene debajo. */
export const ADJUST_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler3D uGrade;
uniform bool uUseGrade;
uniform float uGradeSize;
uniform bool uProtectSkin;
uniform float uSharpen;
uniform float uVignette;
uniform vec2 uSize;
out vec4 outColor;

// Probabilidad de piel por color (YCbCr): sirve para "Proteger el tono de la piel"
// cuando no hay máscara de segmentación (capas de ajuste).
float skinByColor(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5));
  float cr = 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312));
  float d = length(vec2((cb - 0.405) / 0.065, (cr - 0.6) / 0.06));
  return (1.0 - smoothstep(0.7, 1.35, d)) * smoothstep(0.1, 0.22, y);
}

vec4 S(vec2 uv) { return texture(uSrc, vec2(uv.x, 1.0 - uv.y)); }

void main() {
  vec3 o = S(vUv).rgb;
  vec3 c = o;
  if (uSharpen > 0.0) {
    vec2 t = 1.0 / uSize;
    vec3 blur = (S(vUv + vec2(t.x, 0.0)).rgb + S(vUv - vec2(t.x, 0.0)).rgb + S(vUv + vec2(0.0, t.y)).rgb + S(vUv - vec2(0.0, t.y)).rgb) * 0.25;
    c = c + (c - blur) * uSharpen * 1.5;
  }
  if (uUseGrade) {
    vec3 coord = clamp(c, 0.0, 1.0) * ((uGradeSize - 1.0) / uGradeSize) + 0.5 / uGradeSize;
    c = texture(uGrade, coord).rgb;
  }
  if (uProtectSkin) c = mix(c, o, skinByColor(o) * 0.85);
  if (uVignette > 0.0) c *= mix(1.0, smoothstep(0.85, 0.2, length(vUv - 0.5) * 1.4), uVignette * 0.9);
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`
