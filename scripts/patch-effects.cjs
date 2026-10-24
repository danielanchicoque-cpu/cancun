// Parche de una sola vez: agrega efectos nuevos al shader de efectos.
const fs = require('fs')
const p = 'src/renderer/src/gl/shaders.ts'
let s = fs.readFileSync(p, 'utf8')
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 60))
  s = s.replace(a, b)
}

const start = s.indexOf('export const EFFECTS = [')
const end = s.indexOf('] as const', start) + '] as const'.length
s =
  s.slice(0, start) +
  `// El orden define el índice del shader: lo nuevo va siempre al final.
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
] as const` +
  s.slice(end)

rep(
  'float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }\n\nvoid main() {\n  vec2 uv = vUv;\n  float I = uIntensity;',
  `float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
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
  float I = uIntensity;`
)

rep(
  '  outColor = c;\n}`\n\n// Transiciones.',
  `  if (uEffect == 22) { // destellos que titilan
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
}\`

// Transiciones.`
)
fs.writeFileSync(p, s)
console.log('efectos ok')
