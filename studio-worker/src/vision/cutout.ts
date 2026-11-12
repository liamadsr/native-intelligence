/**
 * A subject cut-out: the matte from subject-matte (white = the person, or any
 * main subject) merged with the recording into a transparent VP9 WebM, which the
 * editor's composition plays on top of the layers marked `behind`, so words sit
 * behind the speaker. VP9 carries the alpha channel (as a side stream the WebM
 * marks `alpha_mode`); the cut-out keeps the recording's shape at up to 1920 px.
 */
import { mediaTimeout, run } from '../media.ts'

/** The cut-out's size: the recording's shape, at most 1920 px on its long side, both sides even. Pure. */
export function cutoutSize(width: number, height: number): { w: number; h: number } {
  const scale = Math.min(1, 1920 / Math.max(width, height))
  return { w: Math.max(2, Math.round((width * scale) / 2) * 2), h: Math.max(2, Math.round((height * scale) / 2) * 2) }
}

/**
 * FFmpeg's arguments for the merge: the picture as yuv420p, the matte as grey
 * softened a touch (a 1.2 px blur keeps edges from stepping), merged as the alpha
 * channel, encoded VP9 with alpha at constant quality, no sound. Pure.
 */
export function mergeArgs(input: string, matte: string, output: string, size: { w: number; h: number }): string[] {
  const { w, h } = size
  return [
    '-nostdin', '-y', '-v', 'error', '-i', input, '-i', matte,
    '-filter_complex', `[0:v]scale=${w}:${h},format=yuv420p[v];[1:v]scale=${w}:${h},format=gray,gblur=sigma=1.2[m];[v][m]alphamerge,format=yuva420p[out]`,
    '-map', '[out]', '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-auto-alt-ref', '0',
    output,
  ]
}

/** Merge a recording and its matte into the transparent WebM at `output`. The signal kills FFmpeg. */
export async function mergeCutout(input: string, matte: string, output: string, size: { w: number; h: number }, opts: { seconds?: number; signal?: AbortSignal } = {}): Promise<void> {
  await run('ffmpeg', mergeArgs(input, matte, output, size), { timeout: mediaTimeout(opts.seconds ?? 600, 8), maxBuffer: 4 * 1024 * 1024, signal: opts.signal })
}

/** True when ffprobe's streams say the picture carries an alpha channel (VP9's `alpha_mode` tag, or an alpha pixel format). Pure. */
export function streamsHaveAlpha(streams: { codec_type?: string; pix_fmt?: string; tags?: Record<string, string> }[]): boolean {
  return streams.some((s) => s.codec_type === 'video' && (/^(yuva|gbrap|rgba|bgra|argb|abgr|ya)/.test(s.pix_fmt ?? '') || Object.entries(s.tags ?? {}).some(([k, v]) => k.toLowerCase() === 'alpha_mode' && v === '1')))
}

/** Whether a video file's picture carries an alpha channel. */
export async function hasAlpha(file: string, signal?: AbortSignal): Promise<boolean> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,pix_fmt:stream_tags', '-of', 'json', file], { timeout: 60_000, signal })
  const parsed = JSON.parse(stdout) as { streams?: { codec_type?: string; pix_fmt?: string; tags?: Record<string, string> }[] }
  return streamsHaveAlpha(parsed.streams ?? [])
}
