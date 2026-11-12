import type { EditorProject } from './contracts';

/**
 * The project as the editor's preview draws it: the same edit at preview resolution (longest side 1600 px) instead of
 * the recording's own size (a 4112×2580 screen recording). The Player builds the composition at its full size and
 * shrinks it for display; in Safari's WebKit every full-frame layer of that composition got its own full-size graphics
 * buffer (~42 MB at 4112×2580), so the preview alone used ~1.7 GB, triggered system memory pressure and froze or
 * crashed. Almost everything is positioned in fractions of the frame or scaled by its height already; the few values
 * kept in pixels (frame padding, corner radius, shadow, background blur, caption size, older motion layers' …Px) are
 * scaled here. Exports render the real project at full size.
 */
export function previewProject(project: EditorProject, maxSide = 1600): EditorProject {
  const { width, height } = project.output, k = Math.min(1, maxSide / Math.max(width, height));
  if (k > 0.999) return project;
  const W = Math.max(2, Math.round(width * k / 2) * 2), H = Math.max(2, Math.round(height * k / 2) * 2), s = W / width;
  const p = project.presentation;
  return {
    ...project,
    output: { ...project.output, width: W, height: H },
    presentation: { ...p, padding: p.padding * s, inset: p.inset * s, radius: p.radius * s, blur: p.blur * s, shadow: { ...p.shadow, blur: p.shadow.blur * s, distance: p.shadow.distance * s } },
    captions: { ...project.captions, fontSize: project.captions.fontSize * s },
    clips: project.clips.map(clip => ({ ...clip, motion: scalePx(clip.motion, s) })),
  };
}

/** Every number under a key ending in "Px" (legacy motion layers: font size, stroke width, radius), scaled. */
function scalePx<T>(value: T, s: number): T {
  if (Array.isArray(value)) return value.map(item => scalePx(item, s)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, typeof v === 'number' && key.endsWith('Px') ? v * s : scalePx(v, s)])) as T;
}
