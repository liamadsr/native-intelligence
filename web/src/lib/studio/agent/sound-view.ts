/**
 * How a sound design job (src/lib/studio/server/sound.ts) reads to the agent
 * through get_studio_job / wait_for_studio_job (./job-tools.ts): compact, with
 * the numbers it must quote. A finished listen job also shows its annotated
 * sheet as the answer's image, through the tool image slot, the way finished
 * stills show their frames.
 */
import { imageForModel, TOOL_IMAGE_BASE64, TOOL_IMAGE_MIME_TYPE } from '@/lib/ai/tools/tool-image'
import type { StudioContext } from '@/lib/studio/server/context'
import type { JobRow } from '@/lib/studio/server/jobs'

/** The sound design kinds. */
export const SOUND_JOB_KINDS = ['sounds', 'sound-import', 'listen', 'sound-bank'] as const
export const isSoundJob = (kind: string) => (SOUND_JOB_KINDS as readonly string[]).includes(kind)

/** How much of the scorecard and the transcript the agent is shown. */
const SCORECARD_CHARS = 3000
const HEARD_CHARS = 1200
/** How many placed sounds are listed one by one. */
const LIST_PLACED = 40

type Placed = { cue?: string; sound?: string; at?: number; label?: string }

/** The opening of the listening transcript: its summary paragraph, before the event table. Pure. */
export function heardSummary(text: string): string {
  const table = text.search(/\n\s*(SECTIONS|TRANSCRIPT)\b/)
  return (table > 0 ? text.slice(0, table) : text).trim().slice(0, HEARD_CHARS)
}

/** A finished sound job's result, compact. Pure. */
export function soundJobView(row: Pick<JobRow, 'kind' | 'status' | 'result'>): Record<string, unknown> {
  if (row.status !== 'completed' || !row.result) return {}
  const r = row.result as Record<string, unknown>
  switch (row.kind) {
    case 'sounds':
    case 'sound-import': {
      const placed = (Array.isArray(r.placed) ? r.placed : []) as Placed[]
      const notes = (Array.isArray(r.notes) ? r.notes : []).map(String)
      return {
        ...(placed.length ? { placed: placed.length, sounds: placed.slice(0, LIST_PLACED).map((p) => ({ cue: p.cue, sound: p.sound, at: p.at, label: p.label })) } : {}),
        ...(placed.length > LIST_PLACED ? { more_sounds: placed.length - LIST_PLACED } : {}),
        ...(typeof r.music === 'string' ? { music: r.music } : {}),
        ...(notes.length ? { notes: notes.slice(0, 12) } : {}),
        note: 'Placed on the video (one undoable step; a version was kept). You cannot hear it: listen_to_studio_video before saying anything about how it sounds.',
      }
    }
    case 'listen': {
      const critique = (r.critique ?? {}) as { verdict?: string; score?: number; text?: string }
      const timeline = (r.timeline ?? {}) as { text?: string }
      return {
        ...(critique.verdict ? { verdict: critique.verdict } : {}),
        ...(typeof critique.score === 'number' ? { score: critique.score } : {}),
        ...(critique.text ? { scorecard: critique.text.slice(0, SCORECARD_CHARS) } : {}),
        ...(timeline.text ? { heard: heardSummary(timeline.text) } : {}),
        ...(r.sheet ? { sheet: 'The annotated sheet (events, spectrogram, loudness, sync markers per cue) is attached when you wait for this job.' } : {}),
        note: 'Quote these numbers; fix one thing at a time and listen again.',
      }
    }
    case 'sound-bank':
      return { sounds: r.sounds, presets: r.presets }
    default:
      return {}
  }
}

/** The bytes of one stored file (its parts, joined), read through the links the Studio signs. */
async function blobBytes(ctx: StudioContext, key: string): Promise<Buffer> {
  const { readBlob } = await import('@/lib/studio/agent/server')
  const blob = await readBlob(ctx, key, 300)
  const parts = await Promise.all(
    blob.parts.map(async (part) => {
      const res = await fetch(part.url)
      if (!res.ok) throw new Error(`Couldn't read the listening sheet (${res.status}).`)
      return new Uint8Array(await res.arrayBuffer())
    }),
  )
  return Buffer.concat(parts)
}

/** A finished listen job's sheet as the answer's image (the tool image keys), or a note when it can't be read. */
export async function listenSheetImage(ctx: StudioContext, row: Pick<JobRow, 'kind' | 'status' | 'result'>): Promise<Record<string, unknown>> {
  const sheet = (row.result as { sheet?: { png?: string } } | null)?.sheet
  if (row.kind !== 'listen' || row.status !== 'completed' || !sheet?.png) return {}
  if (process.env.STUDIO_AGENT_FRAMES === 'off') return { sheet: "The sheet was drawn, but images can't be shown to you in this environment: work from the scorecard's numbers." }
  try {
    const image = await imageForModel(await blobBytes(ctx, sheet.png))
    if (!image) return { sheet: "The sheet was drawn but couldn't be read as an image." }
    return { sheet: 'The annotated listening sheet, attached: events, spectrogram, loudness, and a marker per cue (green: an onset within a frame; amber: within 100 ms; red: no hit).', [TOOL_IMAGE_BASE64]: image.base64, [TOOL_IMAGE_MIME_TYPE]: image.mediaType }
  } catch (error) {
    return { sheet: error instanceof Error ? error.message : "The sheet couldn't be read." }
  }
}

/** A finished sound job's part of get_studio_job / wait_for_studio_job's answer (`frames`: the wait, which shows the sheet). */
export async function soundAnswer(ctx: StudioContext, row: Pick<JobRow, 'kind' | 'status' | 'result'>, opts: { frames: boolean }): Promise<Record<string, unknown>> {
  return { ...soundJobView(row), ...(opts.frames ? await listenSheetImage(ctx, row) : {}) }
}
