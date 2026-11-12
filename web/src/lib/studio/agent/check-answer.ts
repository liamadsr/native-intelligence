/**
 * A finished measured check as the agent reads it (get_studio_job and
 * wait_for_studio_job, ./job-tools.ts): the report made compact (numbers, the
 * flags, what to fix first; never the raw arrays of moves, scenes or frames),
 * on the video's clock, and its key picture as the tool's image: the motion
 * check's timeline, the review's scenes sheet, the visual check's contact
 * sheet (the problems boxed).
 */
import { imageForModel } from '@/lib/ai/tools/tool-image'
import { TOOL_IMAGE_BASE64, TOOL_IMAGE_MIME_TYPE } from '@/lib/ai/tools/tool-image'
import type { LookResult, MotionResult, ReviewResult } from '@/lib/studio/server/check-contract'
import type { StudioContext } from '@/lib/studio/server/context'
import type { JobRow } from '@/lib/studio/server/jobs'

/** How many flags, issues and fixes an answer lists at most (the rest are counted). */
export const LIST_MAX = 10

const round2 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n)
const pick = (from: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => from[k] !== undefined).map((k) => [k, round2(from[k])]))

/** The motion summary's numbers worth reading. */
const MOTION_KEYS = ['alive', 'longest_hold', 'holds_over_1s', 'empty_seconds', 'moves', 'moves_per_s', 'median_move_s', 'shapes', 'snap_share', 'hard_stop_share', 'overshoot_share', 'peak_speed_p50', 'elements_when_moving', 'blur_when_moving', 'handoffs', 'transforms', 'crossfades', 'cuts_through_empty']
/** The review profile's numbers worth reading. */
const PROFILE_KEYS = ['seconds', 'scenes', 'median_scene_s', 'scenes_per_min', 'cuts', 'luma', 'text_scene_share', 'words_on_screen_median', 'text_height_median', 'speech_share', 'alive', 'moves_per_s', 'longest_hold']

/** The motion check, compact; times on the video. Pure. */
export function compactMotion(r: MotionResult) {
  const at = (t: number) => Math.round((t + (r.offsetSeconds ?? 0)) * 100) / 100
  const rework = (r.handoffs ?? []).filter((h) => h.kind !== 'transform')
  const issues = r.compare?.issues ?? []
  return {
    check: 'motion' as const,
    summary: pick(r.summary ?? {}, MOTION_KEYS),
    ...(r.compare ? { in_range_percent: Math.round(r.compare.score * 100) } : {}),
    references: r.references ?? [],
    fix_first: issues.slice(0, LIST_MAX).map((i) => `${i.label}: ours ${i.ours}, references ${i.refs.join(' / ')}. ${i.fix}`),
    ...(issues.length > LIST_MAX ? { more_fixes: issues.length - LIST_MAX } : {}),
    handoffs_to_rework: rework.slice(0, LIST_MAX).map((h) => ({ from: at(h.start), to: at(h.end), kind: h.kind })),
    pictures: 'The timeline (thumbnails over the motion curve, moves, holds, handoffs) is attached.',
  }
}

/** The review, compact; times on the video. Pure. */
export function compactReview(r: ReviewResult) {
  const at = (t: number) => Math.round((t + (r.offsetSeconds ?? 0)) * 100) / 100
  const flags = r.issues ?? []
  const off = (r.against?.rows ?? []).filter((row) => (row as { state?: string }).state !== 'ok') as { label: string; ours: unknown; refs: unknown[]; note: string }[]
  return {
    check: 'review' as const,
    scenes: r.scenes,
    profile: pick(r.profile ?? {}, PROFILE_KEYS),
    flags: flags.slice(0, LIST_MAX).map((i) => ({ from: at(i.at), to: at(i.end), kind: i.kind, what: i.text })),
    ...(flags.length > LIST_MAX ? { more_flags: flags.length - LIST_MAX } : {}),
    ...(r.against ? { style: { references: r.against.references, in_range: r.against.in_range, of: r.against.of, off: off.map((row) => `${row.label}: ours ${String(round2(row.ours))}, references ${row.refs.map((v) => String(round2(v))).join(' / ')}${row.note ? `. ${row.note}` : ''}`) } } : {}),
    on_screen_text: r.onScreenText,
    ...(r.note ? { note: r.note } : {}),
    pictures: 'The scenes sheet (each scene\'s keyframes, timing, how it enters, its flags) is attached.',
  }
}

/** The visual check, compact. Pure. */
export function compactLook(r: LookResult) {
  const issues = r.issues ?? []
  const round1 = (n: number) => Math.round(n * 10) / 10
  return {
    check: 'look' as const,
    frames: (r.times ?? []).length,
    issues: issues.slice(0, LIST_MAX).map((i) => ({ kind: i.kind, layer: i.name, layer_id: i.layerId, from: round1(i.from), to: round1(i.to), what: i.detail })),
    ...(issues.length > LIST_MAX ? { more_issues: issues.length - LIST_MAX } : {}),
    overlap: r.overlap,
    ...(r.note ? { note: r.note } : {}),
    pictures: issues.length ? 'The contact sheet (each problem in its worst frame, boxed in red) is attached.' : 'Nothing flagged; a few of the frames are attached.',
  }
}

/** The compact report of a finished check job, or null for any other job. Pure. */
export function compactCheck(row: Pick<JobRow, 'kind' | 'result'>) {
  const r = row.result as Record<string, unknown> | null
  if (!r) return null
  if (row.kind === 'motion') return compactMotion(r as unknown as MotionResult)
  if (row.kind === 'review') return compactReview(r as unknown as ReviewResult)
  if (row.kind === 'look') return compactLook(r as unknown as LookResult)
  return null
}

/** The stored key of a finished check's key picture, or null. Pure. */
export function checkImageKey(row: Pick<JobRow, 'id' | 'kind' | 'result'>): string | null {
  const r = (row.result ?? {}) as { pictures?: Record<string, string>; sheet?: string; files?: string[] }
  const file = row.kind === 'motion' ? r.pictures?.timeline : row.kind === 'review' ? r.pictures?.scenes : row.kind === 'look' ? r.sheet : undefined
  if (!file || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79}\.png$/.test(file)) return null
  return `checks/${row.id}/${file}`
}

/** One stored file's bytes, read through the links the Studio signs. */
async function fileBytes(ctx: StudioContext, key: string): Promise<Buffer> {
  const { readBlob } = await import('@/lib/studio/server/blobs')
  const blob = await readBlob(ctx, key, 300)
  const parts = await Promise.all(
    blob.parts.map(async (part) => {
      const res = await fetch(part.url)
      if (!res.ok) throw new Error(`Couldn't read the check's picture (${res.status}).`)
      return new Uint8Array(await res.arrayBuffer())
    }),
  )
  return Buffer.concat(parts)
}

/** A finished check's answer: `report` (compact) and its key picture as the tool image, or a note when it can't be shown. */
export async function checkAnswer(ctx: StudioContext, row: JobRow): Promise<Record<string, unknown>> {
  const report = compactCheck(row)
  if (!report) return {}
  const key = checkImageKey(row)
  if (!key) return { report }
  if (process.env.STUDIO_AGENT_FRAMES === 'off') return { report, picture: "The check's picture can't be shown to you in this environment; work from the numbers, and ask the person to look in the Studio." }
  try {
    const image = await imageForModel(await fileBytes(ctx, key))
    if (!image) return { report, picture: "The check's picture couldn't be read as an image." }
    return { report, [TOOL_IMAGE_BASE64]: image.base64, [TOOL_IMAGE_MIME_TYPE]: image.mediaType }
  } catch (error) {
    return { report, picture: error instanceof Error ? error.message : "The check's picture couldn't be read." }
  }
}
