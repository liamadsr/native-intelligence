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

/** VideoToolbox's constant quality (0–100). On a Mac (the 20 s bench video) 55 gave 14.6 MB and 47.3 dB at the worst frame against the lossless file, x264 CRF 18 13.4 MB and 47.6 dB; 50 dropped to 43.8 dB, 65 made 21.3 MB. */
export const VIDEOTOOLBOX_QUALITY = 55
/** Media Foundation's quality (0–100) in its quality mode. */
export const MF_QUALITY = 70

/**
 * A bitrate for an encoder with no quality mode: bits a pixel a frame, as for screen recordings (mostly still, sharp
 * text) at x264 CRF 18's typical rate, plus a floor. Pure.
 */
export function mfBitrate(width: number, height: number, fps: number): number {
  return Math.max(4_000_000, Math.round(width * height * fps * 0.04))
}

/**
 * How a hardware encoder is driven, best first (encoder-probe.ts tries them in order on the machine and keeps the first
 * that makes a right file): its constant-quality mode; a bitrate from the pixels and the rate (Intel Macs refuse
 * VideoToolbox's quality mode, many Windows drivers Media Foundation's); the system's own software encoder (a virtual
 * machine, a computer without a hardware encoder). Past the last, the computer cannot export: the Studio uses the server.
 */
export type EncoderRung = 'quality' | 'bitrate' | 'software'
export const RUNGS: readonly EncoderRung[] = ['quality', 'bitrate', 'software']

/**
 * The encoder arguments of a profile for a picture of this size and rate (after `-map`, before the output), at a rung
 * of its ladder (hardware encoders; x264 has one). High profile and no B-frames where the encoder takes it (a hardware
 * encoder with frames reordered can shift the timestamps), a keyframe at least every 2 s (seeking in the file, and the
 * checks that read a frame from a seek). Pure.
 */
export function encoderArgs(profile: EncoderProfile, width: number, height: number, fps: number, rung: EncoderRung = 'quality'): string[] {
  const gop = ['-g', String(fps * 2)], bitrate = ['-b:v', String(mfBitrate(width, height, fps))]
  switch (profile) {
    case 'x264': return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', ...COLOUR_TAGS]
    case 'lossless': return ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', ...gop, ...COLOUR_TAGS]
    case 'videotoolbox': return ['-c:v', 'h264_videotoolbox', ...(rung === 'quality' ? ['-q:v', String(VIDEOTOOLBOX_QUALITY)] : bitrate), '-profile:v', 'high', '-bf', '0',
      ...(rung === 'software' ? ['-require_sw', '1'] : ['-allow_sw', '0']), '-realtime', '0', '-pix_fmt', 'yuv420p', ...gop, ...COLOUR_TAGS]
    case 'mf': return ['-c:v', 'h264_mf', ...(rung === 'quality' ? ['-rate_control', 'quality', '-quality', String(MF_QUALITY)] : ['-rate_control', 'u_vbr', ...bitrate]),
      '-hw_encoding', rung === 'software' ? '0' : '1', '-profile:v', 'high', '-bf', '0', '-pix_fmt', 'nv12', ...gop, ...COLOUR_TAGS]
  }
}

/**
 * What a frame checked against Chrome's drawing of it must score at run time (fast-export-run.ts): the whole frame, and
 * inside the bubble. A hardware encoder at its quality here loses more on fine detail than x264 at CRF 18 (a made-up
 * test card at 1280×720 checked at 34.9 dB with VideoToolbox, about 43 with x264), so its whole-frame floor is lower;
 * the timing is checked bit for bit before the encoder (the frame hashes), and a wrong camera frame still scores
 * about 22 in the bubble.
 */
export function checkFloor(profile: EncoderProfile): { frame: number; bubble: number } {
  return profile === 'videotoolbox' || profile === 'mf' ? { frame: 30, bubble: 25 } : { frame: 34, bubble: 25 }
}

/** The profile for this machine when none is set: VideoToolbox on a Mac, Media Foundation on Windows, x264 elsewhere. Pure. */
export function defaultProfile(platform: NodeJS.Platform): EncoderProfile {
  return platform === 'darwin' ? 'videotoolbox' : platform === 'win32' ? 'mf' : 'x264'
}
