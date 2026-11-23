/**
 * Search inside files (docs/plans/drive-files.md, phase 3), for the palette
 * and the agents' find and search tools, each kind with its own rule:
 *
 *   uploaded files   their extracted text (attachment_chunks, 087: written by
 *                    the attachment-index job), matched on every word typed,
 *                    read on the SERVICE client (chunks are their uploader's
 *                    alone under row security), then fenced for the person
 *                    with the attachments' own rule (filterVisibleAttachments:
 *                    a capture's, a table row's and a Drive upload's, 709).
 *                    No person: the fence answers only what every member reads.
 *   team chat files  their extracted text (team_chat_file_chunk, 710), through
 *                    team_chat_file_search: the channels the person may read,
 *                    the caller or the person a service call names; no person,
 *                    nothing.
 *   mail attachments never: their text is not kept (the 10-15 rule, 344).
 *
 * Nothing here throws: a search that fails finds nothing, and says so.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { filterVisibleAttachments } from '@/lib/attachments/visibility'

export interface UploadTextHit {
  attachmentId: string
  fileName: string
  /** A passage around the first word found. */
  snippet: string
  noteId: string | null
  actionId: string | null
  projectId: string | null
  createdAt: string
}

export interface ChatFileTextHit {
  messageId: string
  channelId: string
  channelKind: string
  channelName: string | null
  filePath: string
  fileName: string
  snippet: string
  createdAt: string
}

/** The words searched: letters and digits, at least two long, at most five words. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, 5)
}

/** A passage of `text` around the first of `words` found in it. */
export function snippetAround(text: string, words: readonly string[], radius = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - radius)
  const end = Math.min(flat.length, at + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Chunks read per search, before the fence. */
const CANDIDATES = 60

/** Uploaded files whose text has every word typed, that `userId` may read (see the header). */
export async function searchUploadText(
  service: SupabaseClient,
  scope: { workspaceId: string; userId: string | null },
  query: string,
  limit = 10,
): Promise<{ hits: UploadTextHit[]; error?: string }> {
  const words = searchWords(query)
  if (!words.length) return { hits: [] }
  try {
    let read = service.from('attachment_chunks').select('attachment_id, chunk_text').eq('workspace_id', scope.workspaceId)
    for (const w of words) read = read.ilike('chunk_text', `%${w}%`)
    const { data: chunks, error } = await read.limit(CANDIDATES)
    if (error) return { hits: [], error: error.message }
    const textOf = new Map<string, string>()
    for (const c of (chunks ?? []) as Array<{ attachment_id: string; chunk_text: string | null }>) {
      if (c.chunk_text && !textOf.has(c.attachment_id)) textOf.set(c.attachment_id, c.chunk_text)
    }
    if (!textOf.size) return { hits: [] }
    const { data: files, error: fileError } = await service
      .from('attachments')
      .select('id, user_id, note_id, action_id, project_id, data_row_id, file_name, created_at')
      .eq('workspace_id', scope.workspaceId)
      .in('id', [...textOf.keys()])
    if (fileError) return { hits: [], error: fileError.message }
    const rows = (files ?? []) as Array<{ id: string; user_id: string | null; note_id: string | null; action_id: string | null; project_id: string | null; data_row_id: string | null; file_name: string; created_at: string }>
    const visible = await filterVisibleAttachments(service, scope, rows)
    return {
      hits: visible
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((f) => ({
          attachmentId: f.id,
          fileName: f.file_name,
          snippet: snippetAround(textOf.get(f.id) ?? '', words),
          noteId: f.note_id,
          actionId: f.action_id,
          projectId: f.project_id,
          createdAt: f.created_at,
        })),
    }
  } catch (err) {
    return { hits: [], error: err instanceof Error ? err.message : 'File search failed' }
  }
}

/**
 * Team chat files whose text matches, in the channels the person may read
 * (710's team_chat_file_search). On a session client the caller is the
 * person; a service client names them with `requestingUserId`.
 */
export async function searchChatFileText(
  client: SupabaseClient,
  scope: { workspaceId: string; requestingUserId?: string | null },
  query: string,
  limit = 8,
): Promise<{ hits: ChatFileTextHit[]; error?: string }> {
  if (searchWords(query).length === 0) return { hits: [] }
  try {
    const { data, error } = await client.rpc('team_chat_file_search', {
      ws: scope.workspaceId,
      q: query.slice(0, 200),
      lim: Math.min(Math.max(1, limit), 25),
      ...(scope.requestingUserId !== undefined ? { p_requesting_user_id: scope.requestingUserId } : {}),
    })
    if (error) return { hits: [], error: error.message }
    return {
      hits: ((data ?? []) as Array<{ message_id: string; channel_id: string; channel_kind: string; channel_name: string | null; file_path: string; file_name: string; snippet: string | null; created_at: string }>).map((r) => ({
        messageId: r.message_id,
        channelId: r.channel_id,
        channelKind: r.channel_kind,
        channelName: r.channel_name,
        filePath: r.file_path,
        fileName: r.file_name,
        snippet: (r.snippet ?? '').replace(/\s+/g, ' ').trim(),
        createdAt: r.created_at,
      })),
    }
  } catch (err) {
    return { hits: [], error: err instanceof Error ? err.message : 'File search failed' }
  }
}
