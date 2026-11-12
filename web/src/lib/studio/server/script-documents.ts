// Scripts and documents feed each other. A script (studio_script, scripts.ts) is what a video says; a document is
// where people write. Two moves, both through the documents library's own rules:
//
//   scriptFromDocument  a video's script from a document the person may read (loadDocumentAccess: the workspace's,
//                       or their own private one), one beat per paragraph, a heading naming the beat after it. The
//                       words are kept as written: only the markup around them goes (heading marks, list bullets,
//                       emphasis, a link's address), and a paragraph longer than a beat holds is cut at a sentence
//                       end. A paragraph that starts "[5s]" keeps that length.
//   scriptToDocument    a new document in the workspace, "<video title>: script", holding the script's text form,
//                       written the way the documents route writes one (its creator, its history from the change
//                       trigger, its search index), and linked to the video (an entity_link: document about video).
//
// No model is called.
import { indexDocument } from '@/lib/ai/embeddings'
import { loadDocumentAccess } from '@/lib/documents/access'
import { isUuid, must, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { getScript, parseScriptText, saveScript, scriptText, type Script, type ScriptBeat } from './scripts'
import { getVideoRow } from './videos'

/** The most beats a script holds, and the most characters one beat's words hold (ScriptSchema). */
const MAX_BEATS = 100
const MAX_TEXT = 2000
const MAX_LABEL = 80

/** A markdown block's words without its markup: heading marks, bullets, quotes, emphasis, a link's address. */
export function plainWords(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*>\s?/, ''))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/** Words longer than a beat holds, cut at sentence ends (a sentence longer than that is cut at a space). */
function cutToBeats(words: string): string[] {
  if (words.length <= MAX_TEXT) return [words]
  const out: string[] = []
  let rest = words
  while (rest.length > MAX_TEXT) {
    const window = rest.slice(0, MAX_TEXT)
    const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '))
    const cut = end > MAX_TEXT / 4 ? end + 1 : Math.max(window.lastIndexOf(' '), MAX_TEXT / 2)
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

/**
 * A document's markdown as script beats: one per paragraph, a heading becoming the label of the paragraph after it.
 * Code blocks, rules and tables are not said, so they are left out. Throws when nothing is left, or too much.
 */
export function beatsFromMarkdown(markdown: string): ScriptBeat[] {
  const text = markdown.replace(/\r\n?/g, '\n').replace(/```[\s\S]*?```/g, '\n\n')
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const beats: ScriptBeat[] = []
  let label: string | undefined
  for (const block of blocks) {
    const heading = /^#{1,6}\s+(.+)$/.exec(block)
    if (heading && !block.includes('\n')) {
      label = plainWords(heading[1]!).replace(/:$/, '').slice(0, MAX_LABEL).trim() || undefined
      continue
    }
    // A rule or a table is layout, not words.
    if (/^([-*_]\s*){3,}$/.test(block) || /^\|.*\|$/m.test(block)) continue
    const words = plainWords(block)
    if (!words) continue
    // The script's own text form, when the document is one ("[5s] Hook:\n…"): its length and name are kept.
    const [own] = parseScriptText(words)
    if (!own) continue
    const pieces = cutToBeats(own.text)
    pieces.forEach((piece, i) => {
      const name = i === 0 ? (own.label ?? label) : undefined
      beats.push({ text: piece, ...(i === 0 && own.seconds && own.seconds <= 600 ? { seconds: own.seconds } : {}), ...(name ? { label: name.slice(0, MAX_LABEL) } : {}) })
    })
    label = undefined
  }
  if (!beats.length) throw new StudioError('That document has no paragraphs to say.')
  if (beats.length > MAX_BEATS) throw new StudioError(`That document makes ${beats.length} beats; a script holds at most ${MAX_BEATS}. Pick a shorter document, or a part of it.`)
  return beats
}

/** The document, read as the person may read it, or a not-found. */
async function readableDocument(ctx: StudioContext, documentId: string): Promise<{ id: string; title: string; content: string }> {
  if (!ctx.userId || !isUuid(documentId)) throw notFoundError('No such document you can read in this workspace.')
  const { access, error } = await loadDocumentAccess(ctx.supabase, ctx.workspaceId, ctx.userId, documentId)
  if (error) throw new StudioError("Couldn't read that document just now. Try again.", 500, 'STORE_FAILED')
  if (!access || !access.memberId || access.row.status === 'archived') throw notFoundError('No such document you can read in this workspace.')
  const row = must(await ctx.supabase.from('document').select('id, title, content').eq('workspace_id', ctx.workspaceId).eq('id', documentId).maybeSingle(), 'read that document') as
    | { id: string; title: string | null; content: string | null }
    | null
  if (!row) throw notFoundError('No such document you can read in this workspace.')
  return { id: row.id, title: row.title?.trim() || 'Untitled', content: row.content ?? '' }
}

/** Write a video's script from a document (replacing the script it had). */
export async function scriptFromDocument(ctx: StudioContext, videoId: string, documentId: unknown): Promise<{ script: Script; document: { id: string; title: string } }> {
  if (typeof documentId !== 'string') throw new StudioError('Choose a document.')
  const doc = await readableDocument(ctx, documentId)
  const beats = beatsFromMarkdown(doc.content)
  const script = await saveScript(ctx, videoId, { beats, title: doc.title.slice(0, 200) })
  return { script, document: { id: doc.id, title: doc.title } }
}

/** The relation a script document has to its video. */
export const SCRIPT_DOCUMENT_RELATION = 'about'

/** Put a video's script in a new document, linked to the video. */
export async function scriptToDocument(ctx: StudioContext, videoId: string): Promise<{ document: { id: string; title: string }; linked: boolean }> {
  if (!ctx.userId) throw new StudioError('Only a person can make a document.')
  const video = await getVideoRow(ctx, videoId)
  if (!video || video.archived_at) throw notFoundError('Project not found')
  const script = await getScript(ctx, videoId)
  if (!script) throw new StudioError('This video has no script yet: write one first.')
  const member = must(
    await ctx.supabase.from('member').select('id').eq('workspace_id', ctx.workspaceId).eq('user_id', ctx.userId).maybeSingle(),
    'read your place in the workspace',
  ) as { id: string } | null
  if (!member) throw new StudioError("You're not a member of this workspace.", 403, 'FORBIDDEN')
  const title = `${video.title.slice(0, 180)}: script`
  const content = scriptText(script)
  const doc = must(
    await ctx.supabase
      .from('document')
      .insert({ workspace_id: ctx.workspaceId, title, content, created_by: member.id, last_edited_by: member.id, status: 'active' })
      .select('id, title, project_id')
      .single(),
    'make that document',
  ) as { id: string; title: string; project_id: string | null }
  // Its search index, as the documents route builds one. Best-effort: a document is never refused for it.
  try {
    await indexDocument(ctx.supabase, doc.id, ctx.userId, doc.project_id ?? null, content, ctx.workspaceId)
  } catch (error) {
    console.error('[studio] indexing a script document failed (non-fatal):', error instanceof Error ? error.message : error)
  }
  const { error } = await ctx.supabase.from('entity_link').upsert(
    {
      workspace_id: ctx.workspaceId,
      source_type: 'document',
      source_id: doc.id,
      target_type: 'studio_video',
      target_id: videoId,
      relation: SCRIPT_DOCUMENT_RELATION,
      created_by: member.id,
    },
    { onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation', ignoreDuplicates: true },
  )
  if (error) console.error('[studio] linking a script document to its video failed:', error.message)
  return { document: { id: doc.id, title: doc.title }, linked: !error }
}
