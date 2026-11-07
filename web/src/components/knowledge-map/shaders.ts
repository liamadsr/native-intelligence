/**
 * GLSL ES 3.00 sources for the Knowledge Map renderer.
 *
 * Deliberately plain: this runs on ANGLE/Metal inside WKWebView (macOS 13+),
 * where clever shaders are where portability bugs live. No extensions, no
 * float render targets, `highp` in the vertex stage (world offsets need the
 * range) and `mediump`-safe fragment stages, explicit `layout(location = …)`
 * on every attribute so the renderer can bind by number without querying.
 *
 * Shared projection contract — every vertex shader does the same thing:
 *
 *   clipXY = (localPos + uTileOffset) * uK * 2 / uViewportCss   with y negated
 *
 * `uTileOffset` is `(tile.ox − camera.x, tile.oy − camera.y)` computed in
 * FLOAT64 on the CPU and only then narrowed to Float32. World coordinates
 * themselves never enter a Float32: at 2^10 zoom they would snap nodes to a
 * multi-pixel lattice (architecture §4.3, "Precision").
 *
 * AXIS CONVENTION. The `px` space above is y-DOWN: world +y paints DOWN the
 * screen. The single negation in `projectLocal` is only the y-down pixels →
 * y-up clip space conversion; it is NOT a world-space flip. Because this file
 * is where the convention is decided, the whole CPU side (camera.ts and
 * everything that calls it) must agree that world +y = screen down and flip
 * nothing. `projectToClip` below is the executable statement of that contract.
 */

/** Vertex attribute locations, shared by the shaders and the VAO setup. */
export const ATTR = {
  corner: 0,
  // Nodes
  nodePos: 1,
  nodeRadius: 2,
  nodeStyle: 3,
  // Edges
  edgeA: 1,
  edgeB: 2,
  // Labels
  labelAnchor: 1,
  labelRect: 2,
  labelUV: 3,
  labelStyle: 4,
} as const

/** Palette slots as the shaders index `uPalette[…]`. Keep in sync with renderer.ts. */
export const PALETTE_SLOT = {
  claim: 0,
  claimSuggested: 1,
  entity: 2,
  virtual: 3,
  edge: 4,
  /** The highlight colour: focus node, its neighbours and their labels — and
   *  their edges for a selection (a hover's edges keep the resting hairline). */
  accent: 5,
  label: 6,
} as const

export const PALETTE_SLOTS = 8

/**
 * A unit quad in TRIANGLE_STRIP order, corners in [-0.5, 0.5]. Every layer
 * expands this same 4-vertex buffer, so there is exactly one non-instanced
 * attribute in the whole renderer.
 */
export const QUAD_STRIP = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])

const PROJECT = /* glsl */ `
// Local (tile-relative, or highlight-origin-relative) world position → clip.
// MIRRORED LINE FOR LINE by projectToClip() in shaders.ts — change both, or
// the CPU (picking, labels) and the GPU (what is painted) disagree about which
// way is up. The negation is the y-DOWN px → y-UP clip flip, nothing else.
vec2 projectLocal(vec2 local, vec2 tileOffset, float k, vec2 viewportCss) {
  vec2 px = (local + tileOffset) * k;
  return vec2(px.x * 2.0 / viewportCss.x, -px.y * 2.0 / viewportCss.y);
}
`

/**
 * The GLSL `projectLocal` above, in TypeScript.
 *
 * Exists to be TESTED, not to be called per frame: the renderer never runs
 * this, it uploads the same inputs as uniforms and lets the GPU do it. Its job
 * is to let a unit test assert that a world point projected by the shaders
 * lands on the same CSS pixel that `camera.worldToScreen` claims — the guard
 * against the two halves of the system drifting apart on the y axis again.
 *
 * Clip → CSS pixel is the standard viewport transform:
 *   px = ((clip.x + 1) / 2 * W,  (1 − clip.y) / 2 * H)
 *
 * @param localX/localY   position relative to the tile (or highlight) origin
 * @param tileOffsetX/Y   `tile.ox − camera.x`, `tile.oy − camera.y`
 * @param k               CSS px per world unit
 * @param viewportW/H     canvas size in CSS px
 */
export function projectToClip(
  localX: number,
  localY: number,
  tileOffsetX: number,
  tileOffsetY: number,
  k: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const pxX = (localX + tileOffsetX) * k
  const pxY = (localY + tileOffsetY) * k
  return {
    x: (pxX * 2) / viewportW,
    y: (-pxY * 2) / viewportH,
  }
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

export const NODE_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;      // unit quad, [-0.5, 0.5]
layout(location = 1) in vec2 aPos;         // tile-local world position
layout(location = 2) in float aRadius;     // world-unit radius
layout(location = 3) in vec2 aStyle;       // x = kind, y = flags (as floats)

uniform vec2 uTileOffset;                  // (tile.ox - cam.x, tile.oy - cam.y)
uniform float uK;                          // CSS px per world unit
uniform vec2 uViewportCss;                 // canvas size in CSS px
uniform float uDpr;
uniform float uMinRadiusPx;
uniform float uMaxRadiusPx;
uniform float uFloorK;                     // zoom below which dots stop shrinking

out vec2 vLocal;                           // quad-local, for the SDF
out float vRadiusPx;                       // on-screen radius in DEVICE px
flat out int vKind;
flat out int vFlags;

${PROJECT}

void main() {
  // Floor the SCALE, not the radius. Clamping r·k alone collapses every node
  // onto uMinRadiusPx at overview zoom (k ≈ 0.1 on a real workspace), which
  // throws away the degree signal the radius carries — a hub and a leaf claim
  // painted as the same speck. See NODE_RADIUS_FLOOR_K in lod.ts, which is the
  // CPU mirror of this line for picking and label placement.
  float rCss = clamp(aRadius * max(uK, uFloorK), uMinRadiusPx, uMaxRadiusPx);
  float rDev = rCss * uDpr;

  // The quad is one pixel wider than the disc on every side so the fwidth
  // antialiasing ramp has somewhere to live.
  float halfCss = rCss + 1.0;

  vec2 centre = projectLocal(aPos, uTileOffset, uK, uViewportCss);
  vec2 offset = aCorner * 2.0 * halfCss;
  gl_Position = vec4(
    centre + vec2(offset.x * 2.0 / uViewportCss.x, -offset.y * 2.0 / uViewportCss.y),
    0.0,
    1.0
  );

  vLocal = aCorner * 2.0 * halfCss * uDpr;   // device px from the centre
  vRadiusPx = rDev;
  vKind = int(aStyle.x + 0.5);
  vFlags = int(aStyle.y + 0.5);
}`

export const NODE_FS = /* glsl */ `#version 300 es
precision mediump float;

in vec2 vLocal;
in float vRadiusPx;
flat in int vKind;
flat in int vFlags;

uniform vec4 uPalette[${PALETTE_SLOTS}];
uniform float uAlpha;      // tile alpha × dim multiplier
uniform int uHighlight;    // 1 = highlight pass: draw everything in the accent

out vec4 outColor;

const int KIND_CLAIM = 0;
const int KIND_ENTITY = 1;
const int KIND_VIRTUAL = 2;
const int FLAG_SUGGESTED = 1;

void main() {
  float d = length(vLocal);
  // One-pixel-wide analytic edge; fwidth is the screen-space derivative of d.
  float aa = max(fwidth(d), 0.0001);

  vec4 colour;
  bool hollow = false;
  if (uHighlight == 1) {
    // The hovered node and its whole neighbourhood in ONE accent colour. Drawn
    // SOLID even for a suggested claim: a hollow ring inside the highlight set
    // reads as "not really selected", and the ring already carries the
    // suggested/confirmed distinction everywhere else on the map.
    colour = uPalette[5];
  } else if (vKind == KIND_ENTITY) {
    colour = uPalette[2];
  } else if (vKind == KIND_VIRTUAL) {
    colour = uPalette[3];
  } else if ((vFlags & FLAG_SUGGESTED) != 0) {
    // Unverified claims read as hollow rings, as in the legacy graph.
    colour = uPalette[1];
    hollow = true;
  } else {
    colour = uPalette[0];
  }

  float mask = 1.0 - smoothstep(vRadiusPx - aa, vRadiusPx + aa, d);
  if (hollow) {
    // Ring thickness never drops below one device pixel or it strobes.
    float thickness = max(1.0, vRadiusPx * 0.34);
    float inner = max(0.0, vRadiusPx - thickness);
    mask *= smoothstep(inner - aa, inner + aa, d);
  }
  if (mask <= 0.0) discard;

  // Palette colours are PREMULTIPLIED, so scaling the whole vec4 is correct.
  outColor = colour * (mask * uAlpha);
}`

// ─── Edges ────────────────────────────────────────────────────────────────────

export const EDGE_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;   // unit quad: x = along, y = across
layout(location = 1) in vec2 aSource;   // tile-local world position
layout(location = 2) in vec2 aTarget;   // tile-local world position

uniform vec2 uTileOffset;
uniform float uK;
uniform vec2 uViewportCss;
uniform float uDpr;
uniform float uWidthCss;                // constant SCREEN-space width
// Length fade, in WORLD units (see EDGE_LENGTH_FADE_* in renderer.ts).
uniform float uLenFadeStart;            // full strength at or below this length
uniform float uLenFadeEnd;              // uLenFadeFloor at or above this length
uniform float uLenFadeFloor;            // alpha multiplier for the longest links
// Declared in BOTH stages, so the precision must be spelled out: int defaults
// to highp in a vertex shader and mediump in a fragment shader, and a uniform
// whose precision differs between stages fails to LINK (caught in a browser —
// no unit test can see it).
uniform mediump int uHighlight;         // 1 = highlight pass: never length-fade

flat out float vLenFade;                // per-instance alpha multiplier

${PROJECT}

void main() {
  // Expand to a screen-space quad here rather than using gl.LINES: LINES is
  // clamped to 1 DEVICE px on WebKit, which is a hairline on a 2× display.
  vec2 aPx = (aSource + uTileOffset) * uK;
  vec2 bPx = (aTarget + uTileOffset) * uK;

  vec2 dir = bPx - aPx;
  float len = length(dir);
  // Degenerate (self-)edges would produce a NaN normal; give them an axis.
  vec2 unit = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-unit.y, unit.x);

  // Fade by WORLD length, not pixel length: a link's length is a property of
  // the graph, so the same link must read the same way at every zoom. len is
  // in CSS px, so divide by k. About half the claims carry a second link to a
  // far-away anchor hub (one real hub has 1,614 of them) and at full strength they
  // cross the viewport as straight lines that drown the short claim->own-hub
  // spokes carrying the actual structure. uHighlight == 1 is the highlight
  // pass, which must show ALL of a hovered hub's long links at full strength —
  // that is how long links are meant to be read.
  float worldLen = uK > 0.0 ? len / uK : 0.0;
  vLenFade = uHighlight == 1
    ? 1.0
    : mix(1.0, uLenFadeFloor, smoothstep(uLenFadeStart, uLenFadeEnd, worldLen));

  // At least one device pixel wide however low the DPR rounds.
  float halfWidth = max(uWidthCss, 1.0 / uDpr) * 0.5;

  vec2 px = aPx + dir * (aCorner.x + 0.5) + normal * (aCorner.y * 2.0 * halfWidth);
  gl_Position = vec4(px.x * 2.0 / uViewportCss.x, -px.y * 2.0 / uViewportCss.y, 0.0, 1.0);
}`

export const EDGE_FS = /* glsl */ `#version 300 es
precision mediump float;

flat in float vLenFade;

uniform vec4 uPalette[${PALETTE_SLOTS}];
uniform float uAlpha;
uniform mediump int uAccent;  // 1 = draw in the accent, 0 = the resting hairline

out vec4 outColor;

void main() {
  // The pale hairline every edge rests at — a HOVERED node's connections
  // included: they stand out because everything else dims, not because they
  // light up. Only a selection with nothing dimmed draws its connections in
  // the accent, since otherwise nothing would set them apart.
  vec4 colour = uAccent == 1 ? uPalette[5] : uPalette[4];
  // Premultiplied palette, so scaling the whole vec4 is the correct fade.
  outColor = colour * (uAlpha * vLenFade);
}`

// ─── Focus rings ──────────────────────────────────────────────────────────────

export const RING_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aPos;
layout(location = 2) in float aRadius;

uniform vec2 uTileOffset;
uniform float uK;
uniform vec2 uViewportCss;
uniform float uDpr;
uniform float uMinRadiusPx;
uniform float uMaxRadiusPx;
uniform float uFloorK;
uniform float uRingPadPx;

out vec2 vLocal;
out float vRadiusPx;

${PROJECT}

void main() {
  // Same scale floor as NODE_VS, or the ring detaches from its dot the moment
  // the camera zooms out past NODE_RADIUS_FLOOR_K.
  float rCss = clamp(aRadius * max(uK, uFloorK), uMinRadiusPx, uMaxRadiusPx) + uRingPadPx;
  float halfCss = rCss + 2.0;
  vec2 centre = projectLocal(aPos, uTileOffset, uK, uViewportCss);
  vec2 offset = aCorner * 2.0 * halfCss;
  gl_Position = vec4(
    centre + vec2(offset.x * 2.0 / uViewportCss.x, -offset.y * 2.0 / uViewportCss.y),
    0.0,
    1.0
  );
  vLocal = aCorner * 2.0 * halfCss * uDpr;
  vRadiusPx = rCss * uDpr;
}`

export const RING_FS = /* glsl */ `#version 300 es
precision mediump float;

in vec2 vLocal;
in float vRadiusPx;

uniform vec4 uPalette[${PALETTE_SLOTS}];
uniform float uAlpha;
uniform float uRingWidthPx;

out vec4 outColor;

void main() {
  float d = length(vLocal);
  float aa = max(fwidth(d), 0.0001);
  float outer = 1.0 - smoothstep(vRadiusPx - aa, vRadiusPx + aa, d);
  float innerR = max(0.0, vRadiusPx - max(1.0, uRingWidthPx));
  float inner = smoothstep(innerR - aa, innerR + aa, d);
  float mask = outer * inner;
  if (mask <= 0.0) discard;
  // Accent, like the rest of the highlight — a selection with no hover draws
  // ONLY this ring, so it is the one mark that has to be found on a busy map.
  outColor = uPalette[5] * (mask * uAlpha);
}`

// ─── Labels ───────────────────────────────────────────────────────────────────

export const LABEL_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aAnchor;   // world position RELATIVE to the label origin
layout(location = 2) in vec4 aRect;     // xy = pixel offset of the box's top-left, zw = size (CSS px)
layout(location = 3) in vec4 aUV;       // u0, v0, u1, v1
layout(location = 4) in float aStyle;   // 1 = emphasised (accent), else label colour

uniform vec2 uTileOffset;
uniform float uK;
uniform vec2 uViewportCss;

out vec2 vUV;
flat out int vEmphasised;

${PROJECT}

void main() {
  vec2 anchorPx = (aAnchor + uTileOffset) * uK;
  // The quad is laid out in PIXELS from the anchor, so text keeps a constant
  // size at every zoom and only its anchor moves.
  vec2 corner = aCorner + 0.5;                    // 0..1
  vec2 px = anchorPx + aRect.xy + corner * aRect.zw;
  gl_Position = vec4(px.x * 2.0 / uViewportCss.x, -px.y * 2.0 / uViewportCss.y, 0.0, 1.0);
  vUV = mix(aUV.xy, aUV.zw, corner);
  vEmphasised = int(aStyle + 0.5);
}`

export const LABEL_FS = /* glsl */ `#version 300 es
precision mediump float;

in vec2 vUV;
flat in int vEmphasised;

uniform sampler2D uAtlas;
uniform vec4 uPalette[${PALETTE_SLOTS}];
uniform float uAlpha;

out vec4 outColor;

void main() {
  // The atlas is rasterised WHITE with premultiplied alpha, so its alpha
  // channel is the glyph coverage and tinting is a straight multiply.
  float coverage = texture(uAtlas, vUV).a;
  if (coverage <= 0.0) discard;
  // Emphasised = in the hovered/selected neighbourhood: those names go accent
  // and crisp while every other label stays muted and secondary to the dots.
  vec4 colour = vEmphasised == 1 ? uPalette[5] : uPalette[6];
  outColor = colour * (coverage * uAlpha);
}`
