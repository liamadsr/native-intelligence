// Small pure helpers both recorders lean on: which container a browser records into, the file name it gets, how far
// apart the sources of one take started, and how loud the microphone is.
import type { TakeRole } from './types'

/** Video containers in order of preference: MP4/H.264 where the browser records it, else WebM. */
export const VIDEO_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const

/** Audio containers in order of preference. */
export const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'] as const

/** The first type the browser says it can record, or null (the browser then picks its own default). */
export function pickType(candidates: readonly string[], isTypeSupported: (type: string) => boolean): string | null {
  for (const type of candidates) {
    try {
      if (isTypeSupported(type)) return type
    } catch {
      // A browser that throws on a type simply does not support it.
    }
  }
  return null
}

/**
 * A video type with an audio codec added when the stream carries sound (the screen with tab audio). MP4 gets AAC,
 * WebM gets Opus; the bare video type is kept when the browser refuses the pair.
 */
export function withAudio(videoType: string | null, isTypeSupported: (type: string) => boolean): string | null {
  if (!videoType) return null
  const paired = videoType.startsWith('video/mp4')
    ? videoType.includes('codecs=') ? videoType.replace(/codecs=([^;]+)/, 'codecs=$1,mp4a.40.2') : `${videoType};codecs=avc1,mp4a.40.2`
    : videoType.includes('codecs=') ? videoType.replace(/codecs=([^;]+)/, 'codecs=$1,opus') : `${videoType};codecs=vp8,opus`
  try {
    return isTypeSupported(paired) ? paired : videoType
  } catch {
    return videoType
  }
}

/** A file extension for a recorded type ("video/webm;codecs=vp9" → "webm"). */
export function extensionFor(type: string): string {
  const base = type.split(';')[0]!.trim().toLowerCase()
  if (base === 'video/mp4' || base === 'audio/mp4') return base === 'audio/mp4' ? 'm4a' : 'mp4'
  if (base === 'audio/ogg') return 'ogg'
  if (base === 'video/x-matroska') return 'mkv'
  if (base === 'video/quicktime') return 'mov'
  return 'webm'
}

const ROLE_NAMES: Record<TakeRole, string> = {
  screen: 'Screen recording',
  camera: 'Camera',
  microphone: 'Microphone',
  'system-audio': 'System audio',
}

/** The library name of one file of a take: "Screen recording 12 Nov, 09:41.webm". */
export function takeFileName(role: TakeRole, extension: string, at: Date): string {
  const when = at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return `${ROLE_NAMES[role]} ${when}.${extension}`.replace(/[\\/:*?"<>|]+/g, '.').slice(0, 240)
}

/**
 * How many seconds after the screen each source started, from the moment each one's recorder started (any common
 * clock: performance.now() in a browser, presentation timestamps on the Mac). The screen is 0; a source that started
 * before the screen is negative. Rounded to the millisecond. A source without a start time is left out.
 */
export function sourceOffsets(starts: Partial<Record<TakeRole, number | null | undefined>>, unit: 'ms' | 's' = 'ms'): Partial<Record<TakeRole, number>> {
  const screen = starts.screen
  if (screen === undefined || screen === null || !Number.isFinite(screen)) return {}
  const scale = unit === 'ms' ? 1000 : 1
  const out: Partial<Record<TakeRole, number>> = {}
  for (const [role, at] of Object.entries(starts) as [TakeRole, number | null | undefined][]) {
    if (at === undefined || at === null || !Number.isFinite(at)) continue
    out[role] = Math.round(((at - screen) / scale) * 1000) / 1000
  }
  return out
}

/** The microphone's loudness from analyser samples (time domain, 0..255 around 128): RMS scaled to 0..1. */
export function levelFrom(samples: ArrayLike<number>): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i]! - 128) / 128
    sum += v * v
  }
  // Speech sits around 0.05..0.3 RMS: lift it so a normal voice fills most of the meter.
  return Math.max(0, Math.min(1, Math.sqrt(sum / samples.length) * 3.2))
}

/** m:ss for the live clock. */
export function clockLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
