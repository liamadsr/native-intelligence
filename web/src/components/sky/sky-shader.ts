/**
 * The sky's one full-screen fragment shader (WebGL1). Drawn at a quarter of
 * the CSS size and scaled up by the browser, so every pixel here covers about
 * sixteen on a retina screen: soft clouds look the same, and it stays cheap.
 * The close-up cloud every dry sky has costs 34 gradient-noise calls a pixel
 * (two layers, each warped, with a few samples toward the light): at this
 * resolution a few million a frame on a large window, light work for a GPU.
 * One fbm for fog. No stars: at a quarter resolution they upscale into soft
 * blobs, and a city sky shows almost none. No rain or snow either, for the same reason: a
 * thin streak or a small flake upscales into a smear, so they are drawn
 * crisp at full resolution on a canvas of their own (sky-precip.ts). The sky
 * here still greys and darkens under them (the palette, uStorm).
 *
 * The screen is a window onto the sky (scene.ts VIEW_*): each pixel is a
 * direction, elevation from just below the horizon at the bottom to about
 * 50° at the top, azimuth across about 100°. The clear sky is built from
 * that direction and the sun's, a few exp calls and no raymarching:
 *   - a Rayleigh-like ramp: the top colour up high, the horizon's pale haze
 *     brightening exponentially toward the horizon, its tail longer from
 *     sunset through the night (uVeil.y), so a dusk or night sky ranges
 *     from a deep zenith through a lighter middle to the horizon;
 *   - city skyglow (uSkyglow): once the daylight goes, the lowest part of
 *     the sky is mixed toward a soft warm grey-mauve haze (a constant
 *     amount), which also lights the clouds a little from below;
 *   - a Mie-like forward glow around the sun, stronger near the horizon;
 *   - in twilight, the glow on the sun's side of the horizon (orange low,
 *     pink and violet above), a little of it all round (GLOW_FLOOR), and
 *     away from the sun the Belt of Venus over Earth's shadow;
 *   - around the sky, relative to the sun (uTex.x): whiter and brighter
 *     toward it, deepest and most saturated about 90° from it (the Rayleigh
 *     and polarization minimum), lifting a little opposite it, so a low sun
 *     sweeps warm to cool ACROSS the screen, not only top to bottom;
 *   - a very low, slow luminance texture (about ±3.5%, SKY_TEXTURE_LUMA) with
 *     a slight warm/cool hue drift (SKY_TEXTURE_HUE), screen-sized patches
 *     with no shapes (uTex.y, quieter at night);
 *   - haze strata (uTex.z): faint, very wide horizontal aerosol layers in the
 *     lowest ~14° of the view, a few percent lighter (taking the sun's colour)
 *     or darker than the sky around them; never cloud shapes.
 *
 * Clear-sky texture costs one extra low-frequency noise call (the strata);
 * the hue drift reuses the luminance texture's noise. The photographic grain
 * is NOT here: at a quarter resolution it would upscale into blotches. It is
 * a static CSS layer over the canvas (sky-grain.tsx).
 *
 * The clouds are seen close up (lib/sky/cloud-closeup.ts), as if a camera
 * looking ahead were zoomed in on one part of a cloud: face on, in
 * screen-height units, no perspective, so the billows are large enough to
 * show their texture and the light on it. Two layers: the near cloud in
 * front, large and drifting fastest, and a farther one behind, smaller,
 * slower and softened toward the sky, so a gap in the near cloud shows cloud
 * beyond. Each is domain-warped fbm of gradient noise (no value-noise grid in
 * the billows), its octaves rotated off each other and the finer ones sliding
 * over time, so the cloud reshapes as it drifts; the near cloud's finer
 * octaves swell into puffy lobes. Its light: the density summed at a few
 * steps toward the light (the sun's side of the screen, from below once the
 * sun is down, broadly from above under a full deck), through Beer's law, so
 * a billow facing the light is bright and one behind more cloud falls softly
 * into shade, plus a little relief to define the lobes; thin edges by the sun
 * glow (a silver lining). Every dry sky has some (the scene's veil): a clear one a few
 * translucent wisps, high cloud silky strands drawn out along the wind; the
 * forecast's cover makes solid cloud, up to a screen full. The wind slides
 * both layers across the screen.
 *
 * Output is opaque: the sky mixed over the theme's own surface colour (uBg)
 * by uStrength, the same over the whole screen (no reading column).
 */

import { VIEW_BOTTOM_DEG, VIEW_CURVE, VIEW_TOP_DEG, VIEW_WIDTH_DEG } from '@/lib/sky/scene'
import {
  CLOSEUP_BACK_SCALE,
  CLOSEUP_BACK_SPEED,
  CLOSEUP_FBM_NORM,
  CLOSEUP_FRONT_SCALE,
  CLOSEUP_FRONT_SPEED,
  CLOSEUP_WARP,
  CLOUD_DRIFT,
  CLOUD_EVOLVE,
  WISP_COVER,
} from '@/lib/sky/cloud-closeup'

/**
 * The close-up cloud's opacity:
 *  - CLOSEUP_SOLID_ALPHA: the near cloud where it is solid (forecast cover):
 *    nearly opaque, so its texture reads, with a breath of sky through it.
 *  - CLOSEUP_WISP_ALPHA: a clear or thinly clouded sky's wisps at most:
 *    see-through, so that sky still reads blue.
 *  - CLOSEUP_BACK_ALPHA: the farther layer (half that behind wisps), and
 *    CLOSEUP_BACK_HAZE how far it is softened toward the sky behind it.
 */
export const CLOSEUP_SOLID_ALPHA = 0.94
export const CLOSEUP_WISP_ALPHA = 0.75
export const CLOSEUP_BACK_ALPHA = 0.6
export const CLOSEUP_BACK_HAZE = 0.5
/** How quickly the light dims through the near cloud (per weighted step of density toward the light). */
export const CLOSEUP_ABSORB = 0.16
/** How much of the twilight glow reaches round the sky away from the sun's side. */
export const GLOW_FLOOR = 0.3
/** City skyglow's height scale above the horizon, degrees: it hugs the horizon, leaving the blue above it. */
export const SKYGLOW_HEIGHT_DEG = 5

/**
 * Clear-sky texture amplitudes (at uTex = 1; the scene scales them down at
 * night and under cloud). Kept small on purpose: texture, never shapes.
 *  - SKY_TEXTURE_LUMA: the low-frequency luminance texture's gain on a noise
 *    of ±0.5, so at most ±4% (typically ±2.5%).
 *  - SKY_TEXTURE_HUE: the warm/cool drift, relative, red up and blue down
 *    (or the reverse) by at most this much.
 *  - SKY_SUN_BRIGHT / SKY_SUN_DEEP: brighter toward the sun (at it, before
 *    the glow) / darker about 90° from it.
 *  - SKY_SUN_SAT: how much more saturated the sky is about 90° from the sun.
 *  - SKY_STRATA_LIGHT / SKY_STRATA_DARK: a haze layer's lighter side mixes
 *    toward its sunlit colour by at most this much, its darker side dims by at
 *    most this much.
 *  - SKY_STRATA_X / SKY_STRATA_Y: noise cells per radian of azimuth, and per
 *    unit of log elevation: stretched far along x, squeezed in y.
 */
export const SKY_TEXTURE_LUMA = 0.08
export const SKY_TEXTURE_HUE = 0.025
export const SKY_SUN_BRIGHT = 0.12
export const SKY_SUN_DEEP = 0.07
export const SKY_SUN_SAT = 0.2
export const SKY_STRATA_LIGHT = 0.6
export const SKY_STRATA_DARK = 0.06
export const SKY_STRATA_X = 1.1
export const SKY_STRATA_Y = 2.4
/** The strata live below this elevation (degrees), fading out from about a third of it. */
export const SKY_STRATA_TOP_DEG = 14

export const SKY_VERTEX = /* glsl */ `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const SKY_FRAGMENT = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

#define VIEW_BOTTOM ${VIEW_BOTTOM_DEG.toFixed(1)}
#define VIEW_TOP ${VIEW_TOP_DEG.toFixed(1)}
#define VIEW_WIDTH ${VIEW_WIDTH_DEG.toFixed(1)}
#define VIEW_CURVE ${VIEW_CURVE.toFixed(3)}
#define DEG 0.01745329
#define CLOUD_DRIFT ${CLOUD_DRIFT.toFixed(3)}
#define CLOUD_EVOLVE ${CLOUD_EVOLVE.toFixed(4)}
#define FRONT_SCALE ${CLOSEUP_FRONT_SCALE.toFixed(3)}
#define BACK_SCALE ${CLOSEUP_BACK_SCALE.toFixed(3)}
#define FRONT_SPEED ${CLOSEUP_FRONT_SPEED.toFixed(3)}
#define BACK_SPEED ${CLOSEUP_BACK_SPEED.toFixed(3)}
#define WARP ${CLOSEUP_WARP.toFixed(3)}
#define FBM_NORM ${CLOSEUP_FBM_NORM.toFixed(3)}
#define WISP_COVER ${WISP_COVER.toFixed(3)}
#define SOLID_ALPHA ${CLOSEUP_SOLID_ALPHA.toFixed(3)}
#define WISP_ALPHA ${CLOSEUP_WISP_ALPHA.toFixed(3)}
#define BACK_ALPHA ${CLOSEUP_BACK_ALPHA.toFixed(3)}
#define BACK_HAZE ${CLOSEUP_BACK_HAZE.toFixed(3)}
#define ABSORB ${CLOSEUP_ABSORB.toFixed(3)}
#define TEX_LUMA ${SKY_TEXTURE_LUMA.toFixed(3)}
#define TEX_HUE ${SKY_TEXTURE_HUE.toFixed(3)}
#define SUN_BRIGHT ${SKY_SUN_BRIGHT.toFixed(3)}
#define SUN_DEEP ${SKY_SUN_DEEP.toFixed(3)}
#define SUN_SAT ${SKY_SUN_SAT.toFixed(3)}
#define STRATA_LIGHT ${SKY_STRATA_LIGHT.toFixed(3)}
#define STRATA_DARK ${SKY_STRATA_DARK.toFixed(3)}
#define STRATA_X ${SKY_STRATA_X.toFixed(3)}
#define STRATA_Y ${SKY_STRATA_Y.toFixed(3)}
#define STRATA_TOP ${SKY_STRATA_TOP_DEG.toFixed(1)}
#define GLOW_FLOOR ${GLOW_FLOOR.toFixed(3)}
#define SKYGLOW_H ${SKYGLOW_HEIGHT_DEG.toFixed(1)}

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uCloud;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunCol;
uniform vec4 uSun;        // x, y (0..1, y up), glow, disc
uniform vec2 uSunDir;     // elevation, azimuth from the window's middle (radians)
uniform vec3 uGlow;       // twilight glow, low on the sun's side
uniform vec3 uGlowHigh;   // the same glow higher up (pink, violet)
uniform vec3 uBelt;       // Belt of Venus
uniform vec3 uShadow;     // Earth's shadow
uniform vec3 uTwi;        // glow amount, belt amount, cirrus (scene.cirrus, 0..1)
uniform vec2 uVeil;       // soft cloud masses' cover, dusk ramp (scene.veil, scene.dusk)
uniform vec4 uSkyglow;    // city skyglow haze colour, amount (scene.skyglow, scene.skyglowAmount)
uniform float uCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uFog;
uniform float uStorm;
uniform vec3 uBg;
uniform float uStrength;
uniform vec3 uTex;        // sun-relative pattern, low-frequency texture, haze strata (scene, 0..1)

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

// Gradient noise for the close-up cloud: about -0.5..0.5, with the quintic
// fade (a smooth second derivative), so the relief light finds no creases
// and no value-noise grid in the billows.
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}

float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i), f);
  float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Each octave twice as fine and turned about 37 degrees off the last, so no
// structure lines up with the screen.
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);

// The cloud's density: n (up to 6) octaves of gradient noise, centred on 0
// (standard deviation about 0.1, FBM_NORM). The two broad octaves shape the
// mass; the finer ones, by \`puff\`, swell into rounded lobes with soft
// creases between them (|g| rounded off, made zero-mean), the cauliflower of
// a cumulus seen up close. The finer octaves also slide against the coarser
// over time (t), so a billow reshapes as it drifts instead of only
// translating; mostly sideways, never as a slide up the screen. Returns the
// sums after 2, 3 and 4 octaves and the whole, so a light sample of fewer
// octaves is compared with the same octaves here (an octave in one and not
// the other would show as hairlines in the shading).
vec4 cloudFbm(vec2 p, float t, int n, float puff) {
  vec4 s = vec4(0.0);
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    float g = gnoise(p + t * vec2(0.8, -0.25) * float(i));
    if (i >= 2) g = mix(g, (sqrt(g * g + 0.0025) - 0.155) * 1.2, puff);
    v += a * g;
    if (i == 1) s = vec4(v);
    if (i == 2) s.yzw = vec3(v);
    if (i == 3) s.zw = vec2(v);
    if (i >= 4) s.w = v;
    p = OCTAVE * p + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  // This pixel as a direction: elevation (degrees and radians) and azimuth
  // from the window's middle; its angular distance from the sun (gamma).
  float elD = mix(VIEW_BOTTOM, VIEW_TOP, pow(clamp(uv.y, 0.0, 1.0), VIEW_CURVE));
  float az = (uv.x - 0.5) * VIEW_WIDTH * DEG;
  float el = elD * DEG;
  // Height above the horizon, eased through zero (a smooth max with 0) so
  // the haze has no crease along the horizon line.
  float h = 0.5 * (elD + sqrt(elD * elD + 4.0));
  float cosG = sin(el) * sin(uSunDir.x) + cos(el) * cos(uSunDir.x) * cos(az - uSunDir.y);
  float gamma = acos(clamp(cosG, -1.0, 1.0));
  float dAz = az - uSunDir.y;

  // The clouds' drift, the controller's offset (the wind): the close-up
  // layers below and the haze strata move with it.
  vec2 drift = uCloud * CLOUD_DRIFT;

  // Rayleigh-like ramp: the horizon's haze falls off exponentially with
  // elevation (a quick near-horizon band and a long tail), so the sky
  // deepens all the way up instead of blending evenly between two colours.
  // From sunset on the tail is longer: the deep zenith shades down through a
  // lighter middle, the range a twilight and a night sky have.
  float hz = mix(0.7 * exp(-h / 7.0) + 0.3 * exp(-h / 26.0), 0.35 * exp(-h / 6.0) + 0.65 * exp(-h / 32.0), uVeil.y);
  vec3 col = mix(uTop, uHorizon, hz);
  // Just below the horizon: the haze thickens a touch and greys.
  col = mix(col, uHorizon * 0.97, (1.0 - smoothstep(VIEW_BOTTOM, 1.0, elD)) * 0.15);

  // Around the sky, relative to the sun. Real clear skies are whiter and
  // brighter toward the sun and darkest, deepest blue about 90° from it (the
  // Rayleigh scattering's polarization minimum), lifting a little again toward
  // the anti-solar point. Broad, so a low sun sweeps the sky warm to cool
  // across the screen. Before the twilight glow, which keeps its own colours.
  float sp = uTex.x;
  if (sp > 0.002) {
    float cg2 = cosG * cosG;
    float toward = exp(-gamma * 2.0);
    float perp = 1.0 - cg2;
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, 1.0 + sp * (SUN_SAT * perp - 0.15 * toward));
    col *= 1.0 + sp * (SUN_BRIGHT * toward + 0.02 * cg2 - SUN_DEEP * perp);
    col = mix(col, uSunCol, sp * 0.06 * toward);
  }

  // Low-frequency texture: screen-sized patches, about ±3.5% in luminance
  // and a little in the haze, plus a slight warm/cool drift (a sine of the
  // position warped by the same noise: no second noise call). Drifts and
  // changes slowly (only while the sky moves), so no clear sky is a flat hue.
  float ta = uTex.y;
  float tex = noise(p * 0.95 + uCloud * 0.12 + vec2(uTime * 0.004, 0.0)) - 0.5;
  col *= 1.0 + tex * TEX_LUMA * ta;
  col = mix(col, uHorizon, tex * 0.1 * hz * ta);
  float warm = sin(dot(p, vec2(2.1, 1.3)) + tex * 5.0 + uCloud.x * 0.05 + uTime * 0.003);
  col *= 1.0 + vec3(1.0, 0.15, -1.0) * (TEX_HUE * ta * warm);

  // Twilight on the sun's side: a glow along the horizon centred on the
  // sun's azimuth, orange low and pink then violet above, its band growing
  // taller and brighter as the sun nears the horizon.
  float twi = uTwi.x;
  float side = exp(-dAz * dAz / 1.45);
  if (twi > 0.002) {
    float bandH = mix(6.0, 12.0, smoothstep(-10.0 * DEG, 1.0 * DEG, uSunDir.x));
    float band = exp(-h / bandH);
    // The pink-violet reach up the sky belongs to twilight: it shrinks back
    // toward the horizon once the sun is up.
    float high = exp(-h / (bandH * 3.2)) * (1.0 - smoothstep(-1.0 * DEG, 5.0 * DEG, uSunDir.x));
    vec3 gcol = mix(uGlow, uGlowHigh, smoothstep(0.0, bandH * 1.8, h));
    // Strongest on the sun's side; once the sun is down, a little of it all
    // the way round (golden hour keeps its sun-side glow only).
    float gw = twi * mix(GLOW_FLOOR * (1.0 - smoothstep(-1.0 * DEG, 4.0 * DEG, uSunDir.x)), 1.0, side) * clamp(band * 0.9 + high * 0.3, 0.0, 1.0);
    col = mix(col, gcol, clamp(gw, 0.0, 0.92));
  }

  // Away from the sun: the Belt of Venus, a soft pink band, over Earth's
  // shadow, a slate-blue band rising from the horizon as the sun sinks.
  float bel = uTwi.y;
  if (bel > 0.002) {
    float anti = smoothstep(0.3, 1.35, abs(dAz));
    float dip = clamp(-uSunDir.x / DEG, 0.0, 9.0);
    float shTop = 0.8 + dip * 0.9;
    float shadow = 1.0 - smoothstep(shTop - 2.5, shTop + 2.5, elD);
    // The belt is brightest just over the shadow and fades slowly upward.
    float bz = (elD - shTop - 3.0) / (elD > shTop + 3.0 ? 7.5 : 3.5);
    float belt = exp(-bz * bz);
    col = mix(col, uBelt, belt * bel * anti * 0.65);
    col = mix(col, uShadow, shadow * bel * anti * 0.6);
  }

  // City skyglow: once the daylight has gone (the amount is faded out by
  // day), the lowest sky turns toward a soft warm grey-mauve haze; above it
  // the blue keeps its colour.
  float sg = uSkyglow.a * (0.85 * exp(-h / SKYGLOW_H) + 0.1 * exp(-h / 30.0));
  col = mix(col, uSkyglow.rgb, sg);

  // The sun: a Mie-like forward glow (wide and tight), stronger where the
  // light crosses more air near the horizon, and when it's up and clear a
  // soft bright core (no hard disc).
  float glow = (exp(-gamma * 3.2) * 0.5 + exp(-gamma * 12.0) * 0.4) * uSun.z * (0.7 + 0.5 * hz);
  // Mostly a blend toward the sun's colour (adding warm light to blue alone
  // turns it green), with a little added on top for the brightness.
  col = mix(col, uSunCol, 0.85 * (1.0 - exp(-glow * 0.9))) + uSunCol * glow * 0.25;
  col += vec3(1.0, 0.97, 0.9) * exp(-gamma * 41.0) * uSun.w * 0.35;

  // Haze strata: faint, very wide aerosol layers low in the view, as at dusk,
  // dawn and in hazy daylight. One noise call, stretched far along x and
  // squeezed in y on a log-elevation coordinate (the receding geometry of the
  // cloud layer: the layers thin toward the horizon), drifting very slowly
  // with the clouds' drift. Lit by the sun: a lighter layer takes its colour
  // (warm at twilight), most on its side; a darker one dims a few percent.
  // Gone well below the cloud field: never a cloud shape.
  float sa = uTex.z;
  if (sa > 0.002) {
    float sn = noise(vec2(az * STRATA_X + drift.x * 0.03 + 7.3, log(h + 1.5) * STRATA_Y + 1.9)) - 0.5;
    float env = smoothstep(-1.5, 1.0, elD) * (1.0 - smoothstep(STRATA_TOP * 0.35, STRATA_TOP, elD));
    float st = clamp(sn * 2.0, -1.0, 1.0) * env * sa;
    vec3 lit = mix(col, uSunCol, 0.3 + 0.3 * side) * 1.04;
    col = mix(col, lit, max(st, 0.0) * STRATA_LIGHT);
    col *= 1.0 + min(st, 0.0) * STRATA_DARK;
  }

  // The close-up cloud (lib/sky/cloud-closeup.ts). Its cover is the
  // forecast's, or in a thinner sky the scene's thin cloud (veil: a clear
  // sky's floor of wisps, more with high cloud), whichever is more.
  float ci = uTwi.z;
  float amount = max(uCover, uVeil.x * WISP_COVER);
  if (amount > 0.01) {
    float et = uTime * CLOUD_EVOLVE;
    // Thin: the cover is only the thin cloud's (see-through wisps); fibrous:
    // drawn out along the wind, partly for a clear sky's wisps and fully for
    // high cloud's silky strands.
    float thin = 1.0 - smoothstep(0.05, 0.25, uCover);
    float fib = thin * mix(0.55, 1.0, smoothstep(0.2, 0.8, ci));
    vec2 stretch = vec2(mix(1.0, 0.4, fib), mix(1.0, 1.8, fib));
    // The light on screen: toward the sun wherever it is (off screen too);
    // once it is well down, from below (the glow, then the city's skyglow).
    float night = 1.0 - smoothstep(-10.0 * DEG, -3.0 * DEG, uSunDir.x);
    vec2 toSun = vec2(uSun.x * aspect, uSun.y) - p;
    vec2 L = toSun / max(length(toSun), 1e-3) * (1.0 - night) - vec2(0.0, night);
    // An overcast's light comes broadly from above, not from a point.
    L = mix(L, vec2(0.0, 1.0), smoothstep(0.6, 1.0, uCover) * 0.85 * (1.0 - night));
    // Right by the sun the cloud is lit from behind (its edges glow, below),
    // not from one side: the light's reach shrinks there.
    L = L / max(length(L), 1e-3) * stretch * mix(smoothstep(0.04, 0.4, length(toSun)), 1.0, night);
    // Solid above this density (in standard deviations): about amount of the
    // screen, and a full deck closes without holes. A wisp's edge is wider and
    // softer than a cloud's.
    float thr = 1.9 * (1.0 - 2.0 * amount) - 1.5 * smoothstep(0.85, 1.0, amount);
    float soft = mix(0.3, 1.3, thin);
    // Shade is cast by the denser cloud: in a full deck only by its thicker
    // lumps, so an overcast still shows its texture.
    float mthr = max(thr, -0.4);
    // Puffy lobes in a cumulus; high cloud's strands stay silky.
    float puff = 1.0 - fib;
    // An overcast's light is diffuse and the city's at night is weak: less relief.
    float relief = mix(1.0, 0.8, smoothstep(0.7, 1.0, uCover)) * mix(1.0, 0.6, night);
    // Mostly sideways: a wind toward the viewer only lifts the cloud a little.
    vec2 wind = drift * vec2(1.0, 0.3);
    // Shared light: the shade takes some of the sky's own colour; the lit side
    // the sun's (warm near it), the twilight glow from below (orange low, pink
    // higher), the city's skyglow at night.
    vec3 amb = mix(mix(uCloudShade, col, 0.22), uSkyglow.rgb, uSkyglow.a * 0.12);
    vec3 lit = uCloudLit + uSunCol * glow * 0.35;
    lit = mix(lit, mix(uGlow, uGlowHigh, smoothstep(0.0, 0.9, uv.y)), twi * mix(0.35, 1.0, side) * 0.55);
    lit = mix(lit, uSkyglow.rgb, uSkyglow.a * 0.18);
    // At night a city lights its clouds from below: lighter than the sky
    // behind them, never a dark blot on it.
    lit = mix(lit, mix(col, uSkyglow.rgb, 0.35) * 1.2, night * 0.6);
    amb = mix(amb, col, night * 0.35);

    // The farther layer: smaller, slower, a little more of it, softened
    // toward the sky behind it; two broad light samples are enough at its size.
    vec2 bq = (p + wind * BACK_SPEED) * stretch * BACK_SCALE + vec2(31.7, 12.3);
    vec2 bw = vec2(gnoise(bq * 0.45 + vec2(0.0, et)), gnoise(bq * 0.45 + vec2(4.1, 7.3 - et))) * WARP;
    vec4 bN = cloudFbm(bq + bw, et, 4, puff) * FBM_NORM;
    float bn = bN.z;
    float bthr = thr - 0.35;
    float ba = smoothstep(bthr - 0.5, bthr + soft * 2.0 + 0.4, bn);
    float bod = smoothstep(mthr - 0.6, mthr + 1.4, cloudFbm(bq + bw + L * (BACK_SCALE * 0.05), et, 2, puff).x * FBM_NORM)
      + 2.0 * smoothstep(mthr - 0.6, mthr + 1.4, cloudFbm(bq + bw + L * (BACK_SCALE * 0.15), et, 2, puff).x * FBM_NORM);
    float bs = mix(0.3, 0.9, exp(-bod * 0.45 * relief)) - 0.15 * smoothstep(mthr + 0.5, mthr + 3.0, bn);
    vec3 bcol = mix(mix(amb, lit, bs), col, BACK_HAZE);
    col = mix(col, bcol, ba * BACK_ALPHA * (1.0 - 0.5 * thin));

    // The near cloud. Its light: the cloud's density summed at a few steps
    // toward the light (its broad octaves), through Beer's law, so a billow
    // facing the light is bright and one with more cloud between it and the
    // light falls softly into shade; then a little relief from a near sample
    // to define the small lobes.
    vec2 fq = (p + wind * FRONT_SPEED) * stretch * FRONT_SCALE + vec2(3.7, 8.1);
    vec2 fw = vec2(gnoise(fq * 0.45 + vec2(0.0, et)), gnoise(fq * 0.45 + vec2(5.2, 1.3 - et))) * WARP;
    vec4 fN = cloudFbm(fq + fw, et, 6, puff) * FBM_NORM;
    float fn = fN.w;
    float f1 = cloudFbm(fq + fw + L * (FRONT_SCALE * 0.022), et, 4, puff).z * FBM_NORM;
    float od = 0.0;
    for (int k = 1; k <= 4; k++) {
      float sd = float(k * k) * 0.014;
      float ns = cloudFbm(fq + fw + L * (FRONT_SCALE * sd), et, 3, puff).y * FBM_NORM;
      od += smoothstep(mthr - 0.6, mthr + 1.4, ns) * float(2 * k - 1);
    }
    float lightT = exp(-od * ABSORB * relief);
    float fa = smoothstep(thr - 0.3, thr + soft, fn);
    float fs = mix(0.18, 1.0, lightT) + (fN.z - f1) * 0.75 * relief;
    // Deep inside, the light is spent: the thick parts a little darker.
    float thick = smoothstep(mthr + 0.5, mthr + 3.0, fn);
    fs = clamp(fs - thick * 0.18, 0.0, 1.0);
    vec3 fcol = mix(amb, lit, fs);
    // A wisp is thin: the sky's light through it lifts its shade.
    fcol = mix(fcol, max(fcol, col), thin * 0.6);
    // Silver lining: thin edges near the sun glow with the light through them.
    float edge = fa * (1.0 - smoothstep(thr, thr + 1.2, fn));
    fcol += uSunCol * glow * edge * 0.8;
    fcol *= 1.0 - uStorm * 0.18 * thick;
    col = mix(col, fcol, fa * mix(SOLID_ALPHA, WISP_ALPHA, thin));
  }

  // Fog: a low-contrast haze, thicker toward the bottom.
  if (uFog > 0.0) {
    float f = fbm(p * 1.6 + uCloud * 0.4 + vec2(uTime * 0.002, 0.0));
    vec3 haze = mix(uHorizon, vec3(dot(uHorizon, vec3(0.3333))), 0.5) * 1.04;
    col = mix(col, haze, uFog * (0.35 + 0.35 * f) * (1.0 - uv.y * 0.5));
  }

  // Rain and snow are drawn over this, crisp, by sky-precip.ts; the storm's
  // darkening stays here.
  col *= 1.0 - uStorm * 0.15;

  // Over-bright (the sun's core): scale back rather than clip per channel,
  // which turns an orange core yellow-green.
  col = max(col, 0.0);
  col /= max(1.0, max(col.r, max(col.g, col.b)));
  // Over the theme surface, the same everywhere: no column, no edge, nothing
  // that depends on x.
  vec3 outc = mix(uBg, col, uStrength);
  // Triangular dither of about one 8-bit step: the canvas is drawn at a
  // quarter size and scaled up, which spreads a lighter dither out, and a dark
  // sky's slow fades then show as bands.
  outc += (hash(frag + 0.37) + hash(frag + 5.21) - 1.0) / 255.0;
  gl_FragColor = vec4(outc, 1.0);
}
`
