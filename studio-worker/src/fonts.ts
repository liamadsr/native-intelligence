/**
 * Fonts for a render. The app puts the font faces a video uses on its export
 * job (job-contract ExportInput.fonts: family, weight, style and the blob key of
 * a woff2 file in the job's workspace). They are downloaded into the job's own
 * scratch folder and served beside the bundle as `fonts/<job id>/<n>.woff2`
 * (a link in the bundle's public folder, removed when the render is done), and
 * the composition is handed those faces as its `fonts` prop: it loads each face
 * and waits for it before drawing a frame, so text renders in its real family.
 *
 * A face that cannot be fetched is left out (its text falls back to the stack),
 * with a line in the job's log; a render never fails for a font.
 */
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobContext } from './jobs/context.ts'

/** A face as the composition loads it (the engine's font-faces.ts FontFace). */
export type FontFace = { family: string; file: string; weight: string; style: 'normal' | 'italic' }

/** At most this many faces per render (a family is one to four files). */
export const MAX_FACES = 64
const FONT_KEY = /^fonts\/[a-zA-Z0-9._-]{1,120}\/[a-zA-Z0-9._-]{1,160}\.woff2$/

/** The faces of a job's input that can be staged: well-formed, under fonts/, woff2, one per file, at most MAX_FACES. Pure. */
export function wantedFaces(value: unknown): FontFace[] {
  if (!Array.isArray(value)) return []
  const out: FontFace[] = []
  const seen = new Set<string>()
  for (const face of value as Partial<FontFace>[]) {
    if (!face || typeof face.family !== 'string' || !face.family.trim() || face.family.length > 120) continue
    if (typeof face.file !== 'string' || !FONT_KEY.test(face.file) || face.file.includes('..')) continue
    const weight = typeof face.weight === 'string' && /^\d{1,4}( \d{1,4})?$/.test(face.weight) ? face.weight : '400'
    const style = face.style === 'italic' ? 'italic' : 'normal'
    const key = `${face.family}|${weight}|${style}|${face.file}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ family: face.family.trim(), file: face.file, weight, style })
    if (out.length >= MAX_FACES) break
  }
  return out
}

/** Where a staged face is served from in the bundle: `fonts/<job id>/<n>.woff2`. Pure. */
export const stagedFile = (jobId: string, index: number) => `fonts/${jobId}/${index}.woff2`

/**
 * Stage a job's fonts beside the bundle at `serveUrl` (the bundle's folder).
 * Answers the faces for the composition's `fonts` prop and a release that takes
 * the link away again (the files go with the job's scratch folder).
 */
export async function stageFonts(ctx: Pick<JobContext, 'job' | 'client' | 'scratch' | 'signal' | 'log'>, value: unknown, serveUrl: string): Promise<{ faces: FontFace[]; release: () => Promise<void> }> {
  const wanted = wantedFaces(value)
  const none = { faces: [] as FontFace[], release: async () => {} }
  if (!wanted.length) return none
  if (/^https?:/.test(serveUrl)) {
    ctx.log('Fonts are not staged for a bundle served over HTTP: text renders with the fallback stack')
    return none
  }
  const dir = join(ctx.scratch, 'fonts')
  await mkdir(dir, { recursive: true })
  const faces: FontFace[] = []
  const failed = new Set<string>()
  for (const [index, face] of wanted.entries()) {
    try {
      await ctx.client.readBlob(ctx.job.id, face.file, join(dir, `${index}.woff2`), { signal: ctx.signal })
      faces.push({ ...face, file: stagedFile(ctx.job.id, index) })
    } catch (err) {
      if (ctx.signal.aborted) throw err
      failed.add(face.family)
    }
  }
  if (failed.size) ctx.log(`Couldn't fetch the font files of ${[...failed].join(', ')}: that text renders with the fallback stack`)
  if (!faces.length) return none
  const parent = join(serveUrl, 'public', 'fonts')
  const link = join(parent, ctx.job.id)
  await mkdir(parent, { recursive: true })
  await rm(link, { recursive: true, force: true })
  await symlink(dir, link, 'dir')
  ctx.log(`Fonts staged: ${[...new Set(faces.map((f) => f.family))].join(', ')}`)
  return { faces, release: () => rm(link, { force: true }).catch(() => undefined) }
}
