/**
 * thumbnail: one small JPEG of a video for lists, the frame at `seconds`, at most
 * 640 px wide, stored at the key the app chose (`thumbs/<video id>.jpg`).
 */
import { join } from 'node:path'
import { deliveredProject } from '../engine.ts'
import { renderFrames } from './stills.ts'
import { frozenProject } from './export.ts'
import { stage, type JobHandler } from './context.ts'

export const THUMBNAIL_WIDTH = 640

/** The scale that brings a picture `width` wide to at most 640 px (never up). Pure. */
export function thumbnailScale(width: number): number {
  return width > THUMBNAIL_WIDTH ? THUMBNAIL_WIDTH / width : 1
}

export const runThumbnail: JobHandler<'thumbnail'> = async (ctx) => {
  const project = frozenProject(ctx.job.input.project)
  // The size the composition renders at is the delivered format's (a reframed view of the edit).
  const scale = thumbnailScale(deliveredProject(project).output.width)
  const output = join(ctx.scratch, 'thumb.jpg')
  await renderFrames(ctx, project, [{ seconds: ctx.job.input.seconds, output }], { scale, imageFormat: 'jpeg', jpegQuality: 80 }, stage(ctx, 0, 0.9))
  await ctx.client.writeBlob(ctx.job.id, ctx.job.input.key, output, 'image/jpeg', { signal: ctx.signal })
  ctx.progress(1)
  return { key: ctx.job.input.key }
}
