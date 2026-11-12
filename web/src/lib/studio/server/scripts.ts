// Scripts: the lines to say while recording, one per beat (studio_script). One script per video; its id, as the
// editor and the recorder see it, is the video's id. The recording dialog picks one, the teleprompter shows it, and
// "Start from the script" builds a storyboard from it.
//
// Text form (what people and the agent write): beats separated by a blank line; a beat may start with "[5s]" (how
// long it should run) and/or "Label:" on its own first line.
import { z } from 'zod'
import { isUuid, must, type StudioContext } from './context'
import { notFoundError } from './errors'

export const ScriptBeatSchema = z.object({ text: z.string().min(1).max(2000), seconds: z.number().positive().max(600).optional(), label: z.string().max(80).optional() }).strict()
export const ScriptSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/), title: z.string().min(1).max(200), beats: z.array(ScriptBeatSchema).min(1).max(100), updatedAt: z.string() }).strict()
export type Script = z.infer<typeof ScriptSchema>
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>

/** "[5s] Label:\nThe words…" blocks → beats. A first line that is only a label is kept as the beat's label. */
export function parseScriptText(text: string): ScriptBeat[] {
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let rest = block
      let seconds: number | undefined
      let label: string | undefined
      const time = /^\[\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*/i.exec(rest)
      if (time) {
        seconds = Number(time[1])
        rest = rest.slice(time[0].length)
      }
      const lines = rest.split('\n')
      if (lines.length > 1 && /^[^.!?"“]{1,60}:$/.test(lines[0]!.trim())) {
        label = lines.shift()!.trim().slice(0, -1)
        rest = lines.join('\n')
      }
      return { text: rest.replace(/\s+/g, ' ').trim(), ...(seconds ? { seconds } : {}), ...(label ? { label } : {}) }
    })
    .filter((b) => b.text)
}

/** Beats back to the text form. */
export const scriptText = (s: { beats: ScriptBeat[] }) => s.beats.map((b) => `${b.seconds ? `[${b.seconds}s] ` : ''}${b.label ? `${b.label}:\n` : ''}${b.text}`).join('\n\n')

type ScriptRow = { id: string; video_id: string | null; title: string; beats: ScriptBeat[]; updated_at: string }
const toScript = (row: ScriptRow): Script | null => {
  const parsed = ScriptSchema.safeParse({ id: row.video_id ?? row.id, title: row.title, beats: row.beats, updatedAt: row.updated_at })
  return parsed.success ? parsed.data : null
}

/** Every script in the workspace, most recently changed first. */
export async function listScripts(ctx: StudioContext): Promise<Script[]> {
  const rows = must(
    await ctx.supabase.from('studio_script').select('id, video_id, title, beats, updated_at').eq('workspace_id', ctx.workspaceId).order('updated_at', { ascending: false }).limit(500),
    'list scripts',
  ) as ScriptRow[] | null
  return (rows ?? []).flatMap((row) => toScript(row) ?? [])
}

async function scriptRow(ctx: StudioContext, id: string): Promise<ScriptRow | null> {
  if (!isUuid(id)) return null
  return must(
    await ctx.supabase.from('studio_script').select('id, video_id, title, beats, updated_at').eq('workspace_id', ctx.workspaceId).eq('video_id', id).maybeSingle(),
    'read that script',
  ) as ScriptRow | null
}

/** A video's script, or null. */
export async function getScript(ctx: StudioContext, id: string): Promise<Script | null> {
  const row = await scriptRow(ctx, id)
  return row ? toScript(row) : null
}

/** Write a video's script: {beats} or {text} (the text form), and an optional title. */
export async function saveScript(ctx: StudioContext, id: string, value: { title?: unknown; beats?: unknown; text?: unknown }): Promise<Script> {
  const beats = value.beats !== undefined ? z.array(ScriptBeatSchema).parse(value.beats) : typeof value.text === 'string' ? parseScriptText(value.text) : []
  const prior = await scriptRow(ctx, id)
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : (prior?.title ?? 'Script')
  const script = ScriptSchema.parse({ id, title, beats, updatedAt: new Date().toISOString() })
  if (prior) {
    must(await ctx.supabase.from('studio_script').update({ title: script.title, beats: script.beats }).eq('workspace_id', ctx.workspaceId).eq('id', prior.id), 'save that script')
    return script
  }
  const video = isUuid(id)
    ? (must(await ctx.supabase.from('studio_video').select('id').eq('workspace_id', ctx.workspaceId).eq('id', id).maybeSingle(), 'save that script') as { id: string } | null)
    : null
  if (!video) throw notFoundError('A script belongs to a video, and there is no video with that id.')
  must(
    await ctx.supabase.from('studio_script').insert({ workspace_id: ctx.workspaceId, video_id: id, title: script.title, beats: script.beats, created_by: ctx.userId }),
    'save that script',
  )
  return script
}
