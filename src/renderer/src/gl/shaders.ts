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
out vec4 outColor;

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

vec3 retouch(vec2 uv, vec3 c, float skin) {
  if (skin <= 0.001) return c;
  float smoothAmt = uRetouch.x;
  if (smoothAmt > 0.0 || uRetouch.z > 0.0) {
    // Filtro bilateral: promedia vecinos parecidos (piel) y respeta bordes (ojos, boca).
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    float radius = 1.0 + 6.0 * max(smoothAmt, uRetouch.z * 0.6);
    for (int i = -3; i <= 3; i++) {
      for (int j = -3; j <= 3; j++) {
        vec2 o = vec2(float(i), float(j)) * radius / 3.0;
        vec3 s = texture(uSrc, uv + o * uTexel).rgb;
        float w = exp(-dot(o, o) / (2.0 * radius * radius)) * exp(-dot(s - c, s - c) * 60.0);
        sum += s * w;
        wsum += w;
      }
    }
    vec3 blurred = sum / wsum;
    float amt = clamp(smoothAmt * 0.9 + uRetouch.z * 0.5, 0.0, 1.0);
    c = mix(c, blurred, amt * skin);
  }
  if (uRetouch.w > 0.0) {
    // Tono uniforme: acerca el color de la piel a su tono medio, sin tocar la luz.
    vec3 avg = textureLod(uSrc, uv, 4.0).rgb;
    float l = luma(c);
    vec3 target = avg * (l / max(luma(avg), 0.001));
    c = mix(c, target, uRetouch.w * 0.6 * skin);
  }
  if (uRetouch.y > 0.0) {
    c = mix(c, 1.0 - (1.0 - c) * (1.0 - 0.35 * uRetouch.y), skin);
    c = mix(c, vec3(luma(c)), 0.12 * uRetouch.y * skin);
  }
  return c;
}

void main() {
  vec2 uv = vec2(mix(uCrop.x, 1.0 - uCrop.z, vUv.x), mix(uCrop.y, 1.0 - uCrop.w, vUv.y));
  if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
  if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
  vec4 src = texture(uSrc, uv);
  vec3 c = src.rgb;
  vec4 seg = uHasSeg ? texture(uSeg, uv) : vec4(1.0, 0.0, 0.0, 1.0);
  if (uRetouch != vec4(0.0) && uHasSeg) c = retouch(uv, c, seg.g);
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
  c = grade(c);
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
export const EFFECTS = [
  { id: 'blur', label: 'Desenfoque' },
  { id: 'shake', label: 'Sacudida' },
  { id: 'glitch', label: 'Glitch' },
  { id: 'rgbsplit', label: 'Aberración RGB' },
  { id: 'zoompulse', label: 'Pulso de zoom' },
  { id: 'flash', label: 'Destello' },
  { id: 'grain', label: 'Grano de película' },
  { id: 'vhs', label: 'VHS' },
  { id: 'bw', label: 'Blanco y negro' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'vignette', label: 'Viñeta' },
  { id: 'lightleak', label: 'Fuga de luz' },
  { id: 'pixelate', label: 'Pixelar' },
  { id: 'mirror', label: 'Espejo' },
  { id: 'cinema', label: 'Barras de cine' },
  { id: 'strobe', label: 'Estroboscopio' },
  { id: 'invert', label: 'Invertir' },
  { id: 'kaleido', label: 'Caleidoscopio' },
  { id: 'scanlines', label: 'Líneas de TV' },
  { id: 'zoomblur', label: 'Desenfoque radial' },
  { id: 'heartbeat', label: 'Latido' },
  { id: 'dreamy', label: 'Ensueño' }
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
  outColor = c;
}`

// Transiciones. Las 16 primeras son el port de xfade (FFmpeg); el resto, propias.
export const TRANSITION_KINDS = [
  'fade', 'dissolve', 'fadeblack', 'fadewhite', 'slideleft', 'slideright', 'slideup', 'slidedown',
  'wipeleft', 'wiperight', 'circleopen', 'circleclose', 'zoomin', 'radial', 'pixelize', 'smoothleft',
  'blur', 'zoomblur', 'spin', 'glitch', 'flash', 'swirl', 'cube', 'pagecurl', 'doorway', 'ripple',
  'luma', 'directionalwarp', 'crosswarp', 'squeeze', 'morph', 'burn', 'colorphase', 'windowslice', 'mosaic', 'heart'
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
