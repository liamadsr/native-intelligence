// Fonts on the composition side (browser-safe): loading the faces (a render waits for them before drawing a frame, so
// text never flashes in a fallback). The names themselves are in font-names.ts; the faces come from the font library.
import { loadFont } from '@remotion/fonts';
import type { FontFace } from './font-names';

export { DEFAULT_FAMILIES, familyOf, fontStack } from './font-names';
export type { FontFace, GenericFont } from './font-names';

/** What kind of font file this is, by its name: the library's files are woff2, a brand's own may be OTF, TTF or woff. */
export function faceFormat(file: string): 'woff2' | 'woff' | 'opentype' | 'truetype' {
  const ext = file.toLowerCase().split('.').pop();
  return ext === 'otf' ? 'opentype' : ext === 'ttf' ? 'truetype' : ext === 'woff' ? 'woff' : 'woff2';
}

const loaded = new Set<string>();
/** Load each face once (in the preview as it arrives; in a render the frame waits for it). */
export function loadFaces(faces: FontFace[] | undefined, url: (file: string) => string) {
  for (const face of faces ?? []) {
    const key = `${face.family}|${face.weight}|${face.style}|${face.file}`; if (loaded.has(key)) continue; loaded.add(key);
    loadFont({ family: face.family, url: url(face.file), weight: face.weight, style: face.style, format: faceFormat(face.file) }).catch(() => loaded.delete(key));
  }
}
