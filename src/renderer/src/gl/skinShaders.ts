/** Pase de pantalla completa en el espacio de la textura (sin voltear): uv de salida = uv de entrada. */
export const SKIN_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`

/**
 * Retoque de piel en varios pases, con la misma receta que el "Suavizar" de CapCut
 * (piel detectada → desenfoque que respeta bordes → aclarado de manchas oscuras → dos
 * desenfoques por valor → separación de frecuencias), más borrar imperfecciones,
 * eliminar arrugas, tono uniforme, blanqueamiento y tono de piel en el pase final.
 *   uMode 1/2: desenfoque de superficie horizontal/vertical (2 guarda la varianza en alfa)
 *   uMode 3:   aclara manchas oscuras (resultado "pre", varianza en alfa)
 *   uMode 4:   desenfoque por valor de 37 muestras (anillos de 3, 6 y 20 px)
 *   uMode 5:   combinación final
 */
export const SKIN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform int uMode;
uniform sampler2D uA;          // entrada del pase (o el original en 3 y 5)
uniform sampler2D uB;          // 3: superficie (pase 2) · 5: pre (pase 3)
uniform sampler2D uC;          // 5: desenfoque por valor (pase 4)
uniform sampler2D uD;          // 5: desenfoque por valor dos veces
uniform sampler2D uSeg;        // g = piel
uniform bool uHasSeg;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uPx;             // píxeles de referencia (1080 p) → píxeles de esta fuente
uniform vec4 uParams;          // suavizar, imperfecciones, arrugas, tono uniforme
uniform float uWhiten;
uniform float uToneAmt;
uniform mat3 uToneM;
uniform vec3 uToneT;
uniform mat3 uWhitenM;
uniform vec3 uWhitenT;
uniform mat3 uBrightM;
uniform vec3 uBrightT;
uniform float uAspect;
uniform int uZoneN;
uniform vec4 uZoneA[16];
uniform vec4 uZoneB[16];       // tipo (0 proteger, 1 arrugas), peso
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toYcc(vec3 c) {
  float y = luma(c);
  return vec3(y, (c.b - y) * 0.5389, (c.r - y) * 0.635);
}
vec3 fromYcc(vec3 v) {
  float r = v.x + v.z / 0.635;
  float b = v.x + v.y / 0.5389;
  return vec3(r, (v.x - 0.2126 * r - 0.0722 * b) / 0.7152, b);
}

float zoneAt(vec2 uv, int kind) {
  vec2 q = vec2(uv.x * uAspect, uv.y);
  float m = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uZoneN) break;
    if (int(uZoneB[i].x + 0.5) != kind) continue;
    vec2 d = (q - uZoneA[i].xy) / uZoneA[i].zw;
    float r2 = dot(d, d);
    if (r2 < 1.0) m = max(m, uZoneB[i].y * smoothstep(1.0, 0.45, r2));
  }
  return m;
}

// Piel donde se puede retocar: máscara de piel menos ojos, cejas y labios.
float skinAt(vec2 uv) {
  float s = uHasSeg ? texture(uSeg, uv).g : 0.0;
  return s * (1.0 - zoneAt(uv, 0));
}

// Puerta de color de CapCut (tono rojizo-anaranjado y no muy oscuro), con bordes suaves
// y aceptando pieles oscuras.
float skinGate(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float h = abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10));
  float v = q.x;
  float hueOk = 1.0 - smoothstep(0.1, 0.15, h) * (1.0 - smoothstep(0.84, 0.89, h));
  return hueOk * smoothstep(0.1, 0.18, v);
}

// Desenfoque de superficie (1D): promedia vecinos de color parecido.
vec4 surfaceBlur(vec2 uv) {
  vec4 cur = texture(uA, uv);
  if (skinAt(uv) <= 0.1) return cur;
  const float tol = 5.2486386;
  float sw = 0.18;
  vec3 sum = cur.rgb * 0.18;
  float sg = cur.g;
  vec2 step1 = uDir * uTexel * 2.5 * uPx;
  float wts[4] = float[4](0.15, 0.12, 0.09, 0.05);
  for (int i = 0; i < 4; i++) {
    for (int s = -1; s <= 1; s += 2) {
      vec3 n = texture(uA, uv + float(s) * float(i + 1) * step1).rgb;
      float w = wts[i] * (1.0 - min(distance(cur.rgb, n) * tol, 1.0));
      sw += w;
      sum += n * w;
      sg += n.g;
    }
  }
  vec3 blurred = sw < 0.4 ? cur.rgb : sw < 0.5 ? mix(cur.rgb, sum / sw, (sw - 0.4) / 0.1) : sum / sw;
  float a = sg / 9.0;
  if (uMode == 2) {
    float v = (cur.g - a) * 7.07;
    a = min(v * v, 1.0);
  }
  return vec4(blurred, a);
}

vec3 xform(mat3 m, vec3 t, vec3 c) { return m * c + t; }

// Desenfoque por valor: anillos de 3, 6 y 20 px; pesa por parecido del verde.
vec4 valueBlur(vec2 uv) {
  vec3 c = texture(uA, uv).rgb;
  if (skinAt(uv) <= 0.1) return vec4(c, 1.0);
  vec2 dirs[4] = vec2[4](vec2(5.0, 0.0), vec2(0.0, 5.0), vec2(3.0, 4.0), vec2(4.0, 3.0));
  float scales[3] = float[3](0.6, 1.2, 4.0);
  vec4 acc = vec4(c, 1.0);
  for (int r = 0; r < 3; r++) {
    for (int d = 0; d < 4; d++) {
      vec2 o = dirs[d] * scales[r] * uPx * uTexel;
      for (int sx = -1; sx <= 1; sx += 2) {
        for (int sy = -1; sy <= 1; sy += 2) {
          // Los ejes (5,0) y (0,5) solo tienen dos signos distintos, como en el original.
          if ((d == 0 && sy > 0) || (d == 1 && sx > 0)) continue;
          vec3 n = texture(uA, uv + o * vec2(float(sx), float(sy))).rgb;
          float dg = n.g - c.g;
          float w = 1.0 - min(dg * dg * 50.0, 1.0);
          acc += vec4(n * w, w);
        }
      }
    }
  }
  return vec4(acc.rgb / acc.w, 1.0);
}

void main() {
  vec2 uv = vUv;
  if (uMode == 1 || uMode == 2) {
    outColor = surfaceBlur(uv);
    return;
  }
  if (uMode == 3) {
    vec4 src = texture(uA, uv);
    vec4 blur = texture(uB, uv);
    vec3 pre = src.rgb;
    float m = skinAt(uv) * skinGate(src.rgb);
    if (m > 0.005) {
      float cd = length(max(blur.rgb - src.rgb, 0.0)) * 28.86751;
      if (cd > 0.5 && cd < 5.0) pre = mix(src.rgb, clamp(xform(uBrightM, uBrightT, src.rgb), 0.0, 1.0), m * (0.0889 * cd + 0.355));
    }
    outColor = vec4(pre, blur.a);
    return;
  }
  if (uMode == 4) {
    outColor = valueBlur(uv);
    return;
  }

  // --- Combinación final ---
  vec4 ori = texture(uA, uv);
  vec4 pre = texture(uB, uv);
  vec3 b3 = texture(uC, uv).rgb;
  vec3 b4 = texture(uD, uv).rgb;
  float skin = skinAt(uv);
  float gate = skinGate(ori.rgb);
  vec3 c = ori.rgb;

  float I = uParams.x * skin;
  if (I > 0.0) {
    float kMin = 1.0 - pre.a / (pre.a + 0.5);
    float area = skin * gate * kMin;
    vec3 even = clamp(b4 + (pre.rgb - b3), 0.0, 1.0);
    even = mix(pre.rgb, even, area);
    float sf = I < 0.6 ? 0.3 : I - 0.3;
    even = mix(even, b4, sf * area);
    c = mix(c, even, I < 0.6 ? I * 1.67 : 1.0);
  }

  if (uParams.y > 0.0) {
    // Imperfecciones: puntos más oscuros o más rojos que la piel de alrededor (b3 ya los
    // excluye porque pesa por parecido) se rellenan con la piel vecina.
    vec3 a0 = toYcc(ori.rgb);
    vec3 a3 = toYcc(b3);
    vec3 a4 = toYcc(b4);
    float dark = smoothstep(0.012, 0.05, a4.x - a0.x) * smoothstep(0.004, 0.02, a3.x - a0.x);
    float red = smoothstep(0.01, 0.04, a0.z - a4.z);
    float spot = clamp(max(dark, red * 0.9), 0.0, 1.0);
    vec3 heal = mix(b3, b4, 0.35);
    c = mix(c, heal, spot * uParams.y * skin * mix(0.4, 1.0, gate));
  }

  if (uParams.z > 0.0) {
    // Arrugas: líneas más oscuras que la piel de alrededor; se aclaran hacia el promedio
    // amplio (sin aplanar la textura fina), con más fuerza en frente, ojos y surcos.
    float zone = max(0.45, zoneAt(uv, 1));
    float k = uParams.z * skin * mix(0.5, 1.0, gate) * zone;
    vec3 a = toYcc(c);
    vec3 a4 = toYcc(b4);
    a.x += max(a4.x - a.x, 0.0) * k * 0.95;
    a.yz = mix(a.yz, a4.yz, k * 0.25);
    c = mix(fromYcc(a), mix(c, b4 + (c - b3) * 0.6, 0.5), k * 0.35);
  }

  if (uParams.w > 0.0) {
    // Tono uniforme: lleva el color (no la luz) hacia el promedio amplio de la piel.
    vec2 o = uTexel * 40.0 * uPx;
    vec3 avg = (b4 + texture(uD, uv + vec2(o.x, 0.0)).rgb + texture(uD, uv - vec2(o.x, 0.0)).rgb +
                texture(uD, uv + vec2(0.0, o.y)).rgb + texture(uD, uv - vec2(0.0, o.y)).rgb) / 5.0;
    vec3 a = toYcc(c);
    a.yz = mix(a.yz, toYcc(avg).yz, uParams.w * 0.6 * skin * gate);
    c = fromYcc(a);
  }

  float face = uHasSeg ? texture(uSeg, uv).g : 0.0;
  if (uWhiten > 0.0) {
    float m = face * (1.0 - 0.7 * zoneAt(uv, 0)) * mix(0.35, 1.0, gate);
    c = mix(c, clamp(xform(uWhitenM, uWhitenT, c), 0.0, 1.0), uWhiten * m);
  }
  if (uToneAmt > 0.0) {
    float m = face * mix(0.3, 1.0, gate);
    c = mix(c, clamp(xform(uToneM, uToneT, c), 0.0, 1.0), uToneAmt * m);
  }
  outColor = vec4(clamp(c, 0.0, 1.0), ori.a);
}`
