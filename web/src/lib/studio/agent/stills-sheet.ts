/**
 * The frames render_studio_stills shows the agent, as ONE image: a model sees
 * a tool's image through the one image slot a tool result has
 * (src/lib/ai/tools/tool-image.ts), so several stills are laid out left to
 * right, top to bottom, on a sheet no larger than a model reads anyway
 * (MODEL_IMAGE_MAX_EDGE). One still is shown on its own, at that size. Fewer
 * frames, bigger frames: the tool says so.
 *
 * sharp is loaded on first use (a native module), as imageForModel does.
 */
import { MODEL_IMAGE_MAX_EDGE, imageForModel, type ModelImage } from '@/lib/ai/tools/tool-image'

/** The gap between frames on the sheet, in pixels. */
const GAP = 8

/** How many columns a sheet of `n` frames takes. */
export function sheetColumns(n: number): number {
  if (n <= 2) return Math.max(1, n)
  if (n <= 4) return 2
  if (n <= 9) return 3
  return 4
}

/**
 * Where each frame goes: cells of the frames' own shape, as large as fit
 * within the edge in both directions. Pure.
 */
export function sheetLayout(n: number, aspect: number, edge = MODEL_IMAGE_MAX_EDGE): { width: number; height: number; cell: { width: number; height: number }; at: { left: number; top: number }[] } {
  const cols = sheetColumns(n)
  const rows = Math.ceil(n / cols)
  const byWidth = (edge - GAP * (cols - 1)) / cols
  const byHeight = ((edge - GAP * (rows - 1)) / rows) * aspect
  const cellWidth = Math.max(16, Math.floor(Math.min(byWidth, byHeight)))
  const cellHeight = Math.max(16, Math.floor(cellWidth / aspect))
  const at = Array.from({ length: n }, (_, i) => ({ left: (i % cols) * (cellWidth + GAP), top: Math.floor(i / cols) * (cellHeight + GAP) }))
  return { width: cols * cellWidth + GAP * (cols - 1), height: rows * cellHeight + GAP * (rows - 1), cell: { width: cellWidth, height: cellHeight }, at }
}

/** The stills as one image for a model, or null when sharp can't read them. */
export async function stillsSheet(stills: Buffer[]): Promise<ModelImage | null> {
  if (!stills.length) return null
  if (stills.length === 1) return imageForModel(stills[0])
  try {
    const { default: sharp } = await import('sharp')
    const first = await sharp(stills[0], { failOn: 'error' }).metadata()
    const aspect = first.width && first.height ? first.width / first.height : 16 / 9
    const layout = sheetLayout(stills.length, aspect)
    const cells = await Promise.all(
      stills.map((bytes) =>
        sharp(bytes, { failOn: 'error' })
          .resize({ width: layout.cell.width, height: layout.cell.height, fit: 'contain', background: '#ffffff' })
          .flatten({ background: '#ffffff' })
          .png()
          .toBuffer(),
      ),
    )
    const { data, info } = await sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: '#ffffff' } })
      .composite(cells.map((input, i) => ({ input, ...layout.at[i] })))
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true })
    return { base64: data.toString('base64'), mediaType: 'image/jpeg', width: info.width, height: info.height }
  } catch {
    return null
  }
}
