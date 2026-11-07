/**
 * The morph: one picture melts into the next through a noise field, with an
 * RGB split that peaks mid-way and resolves to nothing. Adapted from the
 * "melt" transition of React Bits' MorphSlider (reactbits.dev), trimmed to
 * what a still-between-morphs stage needs: no idle drift (a still frame is
 * drawn once, not every frame), no other transition modes.
 *
 * A still frame is uProgress 0 with uFrom = uTo: the picture, untouched.
 * uReduce (prefers-reduced-motion) makes the morph a plain crossfade.
 *
 * Pictures may be translucent (what's behind the canvas shows through): the
 * textures are premultiplied, everything is blended premultiplied, and the
 * output is premultiplied, as the page composites it.
 */

export const MORPH_VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const MORPH_FRAGMENT = `
precision highp float;

uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform vec2 uRes;
uniform vec2 uFromSize;
uniform vec2 uToSize;
uniform float uProgress;
uniform float uTime;
uniform float uIntensity;
uniform float uScale;
uniform float uAberration;
uniform float uReduce;

varying vec2 vUv;

const float PI = 3.14159265359;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Cover-fit: a picture of another aspect fills the stage without stretching.
vec2 coverUV(vec2 uv, vec2 res, vec2 img) {
  float ratio = (res.x / max(res.y, 1.0)) / max(img.x / max(img.y, 1.0), 0.0001);
  vec2 s = ratio > 1.0 ? vec2(1.0, 1.0 / ratio) : vec2(ratio, 1.0);
  return (uv - 0.5) * s + 0.5;
}

vec4 split(sampler2D t, vec2 uv, float ca) {
  vec4 c = texture2D(t, uv);
  return vec4(texture2D(t, uv + vec2(ca, 0.0)).r, c.g, texture2D(t, uv - vec2(ca, 0.0)).b, c.a);
}

void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  float env = sin(p * PI);
  vec2 uv = vUv;
  vec2 uvF = uv;
  vec2 uvT = uv;
  float m = p;

  if (uReduce < 0.5 && p > 0.0) {
    float nn = fbm(uv * uScale + uTime * 0.03);
    float warp = fbm(uv * uScale * 1.7 - uTime * 0.02);
    vec2 g = vec2(nn, warp) - 0.5;
    uvF = uv + g * uIntensity * 0.5 * p;
    uvT = uv - g * uIntensity * 0.5 * (1.0 - p);
    m = smoothstep(nn - 0.15, nn + 0.15, p);
  }

  float ca = uReduce < 0.5 ? uAberration * env * 0.03 : 0.0;
  vec4 from = split(uFrom, coverUV(uvF, uRes, uFromSize), ca);
  vec4 to = split(uTo, coverUV(uvT, uRes, uToSize), ca);
  gl_FragColor = mix(from, to, m);
}
`
