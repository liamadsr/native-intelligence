/**
 * How the fast export encodes its picture: one profile per machine, every one writing the same kind of file (H.264 in
 * yuv420p, labelled BT.709 primaries and matrix, the sRGB transfer, limited range, as the Chrome path's export).
 *
 * - `x264`: the server, as before (render.ts's EXPORT_ENCODING: CRF 18, `veryfast`).
 * - `videotoolbox`: a Mac's own encoder (`h264_videotoolbox`): constant quality (`-q:v`, Apple silicon), High profile.
 * - `mf`: Windows' own encoder (`h264_mf`, Media Foundation): its quality mode where the driver has one, otherwise a
 *   bitrate from the pixels and the frame rate (mfBitrate). Not measured here (no Windows machine): its floor is the
 *   same lossy checks as VideoToolbox's (test/encoder-check.ts).
 * - `lossless`: x264 at QP 0 (the proof: the frames as composed, before any lossy encoder).
 *
 * A hardware encoder is not bit-comparable with the Chrome path's x264 output, so the proof is in two steps: the
 * composed frames, encoded `lossless`, against Chrome's frame by frame (geometry and timing, test/fast-export-e2e.ts);
 * then each lossy profile's file against the lossless one (quality floor, size, tags, timing, joins).
 */

export type EncoderProfile = 'x264' | 'videotoolbox' | 'mf' | 'lossless'
export const ENCODER_PROFILES: readonly EncoderProfile[] = ['x264', 'videotoolbox', 'mf', 'lossless']

/** The labels every profile writes (the Chrome path's: render.ts, bt709WithSwscale). */
export const COLOUR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv']

/** VideoToolbox's constant quality (0–100): measured on a Mac against the lossless file (test/encoder-check.ts). */
export const VIDEOTOOLBOX_QUALITY = 65
/** Media Foundation's quality (0–100) in its quality mode. */
export const MF_QUALITY = 70

/**
 * A bitrate for an encoder with no quality mode: bits a pixel a frame, as for screen recordings (mostly still, sharp
 * text) at x264 CRF 18's typical rate, plus a floor. Pure.
 */
export function mfBitrate(width: number, height: number, fps: number): number {
  return Math.max(4_000_000, Math.round(width * height * fps * 0.06))
}

/**
 * The encoder arguments of a profile for a picture of this size and rate (after `-map`, before the output). A
 * keyframe at least every 2 s for every profile (seeking in the file, and the checks that read a frame from a seek).
 * Pure.
 */
export function encoderArgs(profile: EncoderProfile, width: number, height: number, fps: number): string[] {
  const gop = ['-g', String(fps * 2)]
  switch (profile) {
    case 'x264': return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', ...COLOUR_TAGS]
    case 'lossless': return ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', ...gop, ...COLOUR_TAGS]
    case 'videotoolbox': return ['-c:v', 'h264_videotoolbox', '-q:v', String(VIDEOTOOLBOX_QUALITY), '-profile:v', 'high', '-allow_sw', '0', '-realtime', '0',
      '-pix_fmt', 'yuv420p', ...gop, ...COLOUR_TAGS]
    case 'mf': return ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', String(MF_QUALITY), '-hw_encoding', '1', '-b:v', String(mfBitrate(width, height, fps)),
      '-pix_fmt', 'nv12', ...gop, ...COLOUR_TAGS]
  }
}

/** The profile for this machine when none is set: VideoToolbox on a Mac, Media Foundation on Windows, x264 elsewhere. Pure. */
export function defaultProfile(platform: NodeJS.Platform): EncoderProfile {
  return platform === 'darwin' ? 'videotoolbox' : platform === 'win32' ? 'mf' : 'x264'
}
