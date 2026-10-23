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

export const LAYER_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler3D uGrade;
uniform bool uUseGrade;
uniform float uGradeSize;
uniform float uOpacity;
uniform vec2 uTexel;
uniform float uSharpen;
uniform float uVignette;
uniform bool uChroma;
uniform vec3 uKey;
uniform float uKeyIntensity;
uniform float uKeyShadow;
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

void main() {
  vec4 src = texture(uSrc, vUv);
  vec3 c = src.rgb;
  if (uSharpen > 0.0) {
    vec3 blur = (
      texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb +
      texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb) * 0.25;
    c = c + (c - blur) * uSharpen * 1.5;
  }
  float alpha = src.a;
  if (uChroma) {
    float d = distance(chromaUV(c), chromaUV(uKey));
    float sim = 0.05 + uKeyIntensity * 0.5;
    float blend = max(uKeyShadow * 0.5, 0.0001);
    alpha *= clamp((d - sim * 0.35) / (blend * 0.35), 0.0, 1.0);
  }
  c = grade(c);
  if (uVignette > 0.0) {
    vec2 q = vUv - 0.5;
    c *= mix(1.0, smoothstep(0.85, 0.2, length(q) * 1.4), uVignette * 0.9);
  }
  float a = alpha * uOpacity;
  outColor = vec4(c * a, a);
}`

/** Pinta una textura (premultiplicada) tal cual; sirve para componer capas y para texto. */
export const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uOpacity;
out vec4 outColor;
void main() { outColor = texture(uSrc, vUv) * uOpacity; }`

// Transiciones con los mismos nombres que xfade de ffmpeg (la exportación usa xfade).
export const TRANSITION_KINDS = [
  'fade', 'dissolve', 'fadeblack', 'fadewhite', 'slideleft', 'slideright', 'slideup', 'slidedown',
  'wipeleft', 'wiperight', 'circleopen', 'circleclose', 'zoomin', 'radial', 'pixelize', 'smoothleft'
] as const

// Port directo de libavfilter/vf_xfade.c (FFmpeg) para que la vista previa sea igual
// a la exportación. Allí "progress" va de 1 a 0 y mix(a,b,m) = a*m + b*(1-m).
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
vec4 cmix(vec4 a, vec4 b, float m) { return a * m + b * (1.0 - m); }
float frand(vec2 p) { float r = sin(p.x * 12.9898 + p.y * 78.233) * 43758.545; return r - floor(r); }

void main() {
  float P = 1.0 - clamp(uP, 0.0, 1.0);
  float W = uSize.x;
  float H = uSize.y;
  vec2 px = floor(vUv * uSize) + 0.5;
  float x = px.x;
  float y = px.y;
  vec4 a = A(px);
  vec4 b = B(px);
  vec4 black = vec4(0.0, 0.0, 0.0, 1.0);
  vec4 white = vec4(1.0);

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
    vec2 uv = 0.5 + (px / uSize - 0.5) * zf;
    vec4 zv = A(ceil(uv * (uSize - 1.0)) + 0.5);
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
  outColor = cmix(a, b, P);
}`
