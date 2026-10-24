// Parche de una sola vez: agrega transiciones nuevas (al estilo de las de CapCut).
const fs = require('fs')
const NEW = [
  'whipleft', 'whipright', 'zoomout', 'spinblur', 'camshake', 'lens', 'lightleak', 'burnflash',
  'lightbeam', 'lightning', 'glowmix', 'push', 'bounce', 'star', 'gridflip', 'flip3d', 'liquid',
  'gridshift', 'signal', 'doubleexposure', 'rgbshift', 'curtain'
]

let p = 'src/renderer/src/gl/shaders.ts'
let s = fs.readFileSync(p, 'utf8')
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 60))
  s = s.replace(a, b)
}
rep(
  "'luma', 'directionalwarp', 'crosswarp', 'squeeze', 'morph', 'burn', 'colorphase', 'windowslice', 'mosaic', 'heart'\n] as const",
  "'luma', 'directionalwarp', 'crosswarp', 'squeeze', 'morph', 'burn', 'colorphase', 'windowslice', 'mosaic', 'heart',\n  " +
    NEW.map((k) => `'${k}'`).join(', ') +
    '\n] as const'
)
rep(
  "bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }",
  `bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }
vec4 Ab(vec2 uv) { return inside(uv) ? Au(uv) : vec4(0.0, 0.0, 0.0, 1.0); }
vec4 Bb(vec2 uv) { return inside(uv) ? Bu(uv) : vec4(0.0, 0.0, 0.0, 1.0); }
// Desenfoque de movimiento en una dirección (en uv).
vec4 blurA(vec2 uv, vec2 dir) { vec4 s = vec4(0.0); for (int i = 0; i < 12; i++) s += Ab(uv + dir * (float(i) / 11.0 - 0.5)); return s / 12.0; }
vec4 blurB(vec2 uv, vec2 dir) { vec4 s = vec4(0.0); for (int i = 0; i < 12; i++) s += Bb(uv + dir * (float(i) / 11.0 - 0.5)); return s / 12.0; }
vec3 scr(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
float ease(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }`
)

const shaders = `  if (uKind == 36 || uKind == 37) { // tirar a la izquierda / derecha (latigazo de cámara)
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
    float half = 0.5 * (1.0 - e);
    bool curtainL = uv.x < half;
    bool curtainR = uv.x > 1.0 - half;
    float fold = sin(uv.x * 60.0) * 0.08;
    vec3 cloth = vec3(0.45, 0.04, 0.08) * (0.8 + fold);
    if (p < 0.5) { float c2 = 0.5 * ease(p * 2.0); outColor = (uv.x < c2 || uv.x > 1.0 - c2) ? vec4(cloth, 1.0) : a; return; }
    float c3 = 0.5 * (1.0 - ease((p - 0.5) * 2.0));
    outColor = (uv.x < c3 || uv.x > 1.0 - c3) ? vec4(cloth, 1.0) : b; return;
  }
  outColor = mix(a, b, p);
}\``
rep('  outColor = mix(a, b, p);\n}`', shaders)
fs.writeFileSync(p, s)

p = 'src/shared/project.ts'
s = fs.readFileSync(p, 'utf8')
rep("  | 'heart'\n\nexport interface Transition", "  | 'heart'\n" + NEW.map((k) => `  | '${k}'`).join('\n') + '\n\nexport interface Transition')
fs.writeFileSync(p, s)

p = 'src/renderer/src/components/catalog.ts'
s = fs.readFileSync(p, 'utf8')
const start = s.indexOf('export const TRANSITIONS')
const end = s.indexOf(']', s.indexOf('= [', start)) + 1
const list = [
  ['fade', 'Mezclar', 'Básico'], ['dissolve', 'Disolver', 'Básico'], ['fadeblack', 'Fundido a negro', 'Básico'], ['fadewhite', 'Destello blanco', 'Básico'],
  ['wipeleft', 'Barrido ←', 'Básico'], ['wiperight', 'Barrido →', 'Básico'], ['smoothleft', 'Barrido suave', 'Básico'], ['circleopen', 'Círculo abrir', 'Básico'], ['circleclose', 'Círculo cerrar', 'Básico'],
  ['whipleft', 'Tirar a la izquierda', 'Cámara'], ['whipright', 'Tirar a la derecha', 'Cámara'], ['zoomin', 'Acercar', 'Cámara'], ['zoomout', 'Alejar', 'Cámara'], ['spin', 'Giro', 'Cámara'], ['camshake', 'Sacudida', 'Cámara'], ['lens', 'Lente', 'Cámara'], ['push', 'Empujar', 'Cámara'],
  ['flash', 'Flash', 'Luz'], ['lightleak', 'Fuga de luz', 'Luz'], ['burnflash', 'Destello quemado', 'Luz'], ['lightbeam', 'Haz de luz', 'Luz'], ['lightning', 'Rayo potente', 'Luz'], ['glowmix', 'Brillo', 'Luz'], ['burn', 'Quemar', 'Luz'],
  ['blur', 'Desenfoque', 'Desenfocar'], ['zoomblur', 'Zoom radial', 'Desenfocar'], ['spinblur', 'Rotación con desenfoque', 'Desenfocar'], ['luma', 'Por luz', 'Desenfocar'],
  ['slideleft', 'Deslizar ←', 'Deslizar'], ['slideright', 'Deslizar →', 'Deslizar'], ['slideup', 'Deslizar ↑', 'Deslizar'], ['slidedown', 'Deslizar ↓', 'Deslizar'], ['bounce', 'Deslizar con rebote', 'Deslizar'], ['squeeze', 'Apretar', 'Deslizar'],
  ['cube', 'Cubo', '3D'], ['flip3d', 'Volteo', '3D'], ['pagecurl', 'Pasar página', '3D'], ['doorway', 'Puertas', '3D'], ['curtain', 'Cortina', '3D'], ['gridflip', 'Mosaicos que giran', '3D'],
  ['glitch', 'Glitch', 'Distorsión'], ['signal', 'Distorsión de señal', 'Distorsión'], ['rgbshift', 'Cambio RGB', 'Distorsión'], ['pixelize', 'Pixelar', 'Distorsión'], ['mosaic', 'Mosaico', 'Distorsión'], ['gridshift', 'Delirio de cuadrícula', 'Distorsión'], ['swirl', 'Remolino', 'Distorsión'], ['ripple', 'Ondas', 'Distorsión'], ['liquid', 'Difusión líquida', 'Distorsión'], ['directionalwarp', 'Deformar', 'Distorsión'], ['crosswarp', 'Deformar cruzado', 'Distorsión'], ['morph', 'Transformar', 'Distorsión'],
  ['doubleexposure', 'Doble exposición', 'Superposición'], ['colorphase', 'Fase de color', 'Superposición'], ['radial', 'Radial', 'Superposición'], ['windowslice', 'Persianas', 'Superposición'], ['heart', 'Corazón', 'Superposición'], ['star', 'Estrella', 'Superposición']
]
s =
  s.slice(0, start) +
  'export const TRANSITIONS: { kind: TransitionKind; label: string; group: string }[] = [\n' +
  list.map(([k, l, g]) => `  { kind: '${k}', label: '${l}', group: '${g}' }`).join(',\n') +
  '\n]' +
  s.slice(end)
fs.writeFileSync(p, s)
console.log('transiciones ok', list.length)
