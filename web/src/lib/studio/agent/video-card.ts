/**
 * What the chat's Studio video card draws (src/app/account/(dashboard)/chat/
 * studio-video-card.tsx), read from the Studio tools' answers
 * (src/lib/ai/tools/studio.ts):
 *
 *   create_studio_video   the video made
 *   get_studio_video      the video read
 *   edit_studio_video     the video as the edit left it
 *   export_studio_video   the video, its export queued
 *   get_studio_job,
 *   wait_for_studio_job   a finished export: the video and its download link
 *
 * Only what the answer already says. Null (the generic chip instead) for a
 * refusal, a job that is not an export, or one still running when polled.
 * Pure.
 */

/** The tools that draw a card here. */
export const STUDIO_VIDEO_CARD_TOOLS = [
  'create_studio_video',
  'get_studio_video',
  'edit_studio_video',
  'export_studio_video',
  'get_studio_job',
  'wait_for_studio_job',
] as const

export interface StudioVideoCardVideo {
  id: string
  title: string
  status: string | null
  width: number | null
  height: number | null
  seconds: number | null
  /** The Studio project it is in, by name. */
  studioProject: string | null
  thumbnailUrl: string | null
}

export type StudioVideoCardVerb = 'made' | 'read' | 'edited' | 'exporting' | 'exported' | 'export-failed'

export interface StudioVideoCardData {
  verb: StudioVideoCardVerb
  video: StudioVideoCardVideo
  /** A finished export's file. */
  downloadUrl: string | null
  /** edit_studio_video: how many commands the step applied. */
  edits: number | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The video a tool's answer names, or null. */
export function studioCardVideo(v: unknown): StudioVideoCardVideo | null {
  if (!isRecord(v)) return null
  const id = str(v.id)
  const title = str(v.title)
  if (!id || !title) return null
  const project = isRecord(v.studio_project) ? str(v.studio_project.title) : null
  return {
    id,
    title,
    status: str(v.status),
    width: num(v.width),
    height: num(v.height),
    seconds: num(v.seconds),
    studioProject: project,
    thumbnailUrl: str(v.thumbnail_url),
  }
}

/** The card for a tool's answer, or null. */
export function studioVideoCardOf(toolName: string, output: unknown): StudioVideoCardData | null {
  if (!isRecord(output) || output.success !== true) return null
  const video = studioCardVideo(output.video)
  if (!video) return null
  const card = (verb: StudioVideoCardVerb, extra: Partial<StudioVideoCardData> = {}): StudioVideoCardData => ({ verb, video, downloadUrl: null, edits: null, ...extra })
  switch (toolName) {
    case 'create_studio_video':
      return card('made')
    case 'get_studio_video':
      return card('read')
    case 'edit_studio_video':
      return card('edited', { edits: Array.isArray(output.results) ? output.results.length : null })
    case 'export_studio_video':
      return card('exporting')
    case 'get_studio_job':
    case 'wait_for_studio_job': {
      const job = isRecord(output.job) ? output.job : null
      if (!job || job.kind !== 'export') return null
      if (job.status === 'completed') return card('exported', { downloadUrl: str(job.download_url) })
      if (job.status === 'failed') return card('export-failed')
      return null
    }
  }
  return null
}

/** "16:9", "9:16", "1:1", "4:5"; else "1080×1350". */
export function aspectLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const d = gcd(width, height)
  const [w, h] = [width / d, height / d]
  return w <= 32 && h <= 32 ? `${w}:${h}` : `${width}×${height}`
}

/** "0:15", "1:02:05". */
export function lengthLabel(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** "16:9 · 0:15 · Draft". */
export function videoCardLine(video: Pick<StudioVideoCardVideo, 'width' | 'height' | 'seconds' | 'status'>): string {
  const status = video.status ? video.status[0].toUpperCase() + video.status.slice(1) : null
  return [aspectLabel(video.width, video.height), lengthLabel(video.seconds), status].filter(Boolean).join(' · ')
}
