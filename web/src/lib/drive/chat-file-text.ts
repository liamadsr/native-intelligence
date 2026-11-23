/**
 * The text inside a team chat message's files (migration 697;
 * docs/plans/drive-files.md, phase 3): each file's text extracted (the
 * attachments' own extractor: lib/attachments/extract-text.ts), chunked and
 * written to team_chat_file_chunk, so search and agents find a file by what
 * it says, for the channel's readers only (697's policy and search).
 *
 * SERVICE ROLE: the job runs unattended; the rows it writes are read only
 * through 697's rules. It reads the message as it is now: a message deleted,
 * or a file no longer on it, is not indexed (697's trigger removes what was).
 * A message's passages are replaced whole, so indexing again never doubles.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkText, extractAttachmentText, TEXT_EXTRACTABLE_EXTENSIONS } from '@/lib/attachments/extract-text'
import { extensionOf } from '@/lib/files/viewer-kind'
import type { TeamChatAttachment } from '@/lib/team-chat/types'

/** The event that asks for a message's files to be read (sent by the messages route). */
export const TEAM_CHAT_FILES_POSTED = 'team-chat/files.posted'

/** The bucket team chat files live in (558). */
export const TEAM_CHAT_FILES_BUCKET = 'team-chat-files'

/** Passages a file keeps at most (697 allows 200). */
export const MAX_CHAT_FILE_CHUNKS = 40

export interface ChatFileIndexResult {
  /** Files whose text was written. */
  indexed: number
  /** Files with no text to keep (an image, a scanned PDF, an unknown kind). */
  skipped: number
  /** Passages written. */
  chunks: number
  /** Nothing done: the message is gone or deleted. */
  gone?: boolean
}

export interface ChatFileIndexDeps {
  extract?: (bytes: Buffer, extension: string) => Promise<string | null>
}

/** Extract, chunk and store the text of one message's files (see the header). */
export async function indexTeamChatMessageFiles(service: SupabaseClient, messageId: string, deps: ChatFileIndexDeps = {}): Promise<ChatFileIndexResult> {
  const extract = deps.extract ?? extractAttachmentText
  const { data: message, error } = await service
    .from('team_chat_message')
    .select('id, channel_id, workspace_id, deleted_at, attachments')
    .eq('id', messageId)
    .maybeSingle()
  if (error) throw new Error(`team chat file index: ${error.message}`)
  const row = message as { id: string; channel_id: string; workspace_id: string; deleted_at: string | null; attachments: TeamChatAttachment[] | null } | null
  if (!row || row.deleted_at) return { indexed: 0, skipped: 0, chunks: 0, gone: true }

  const rows: Array<{ workspace_id: string; channel_id: string; message_id: string; file_path: string; file_name: string; chunk_index: number; chunk_text: string }> = []
  let indexed = 0
  let skipped = 0
  for (const file of row.attachments ?? []) {
    const ext = extensionOf(file.name)
    // Only a file of this message's own channel folder (558's path rule), and one the extractor reads.
    if (!file.path?.startsWith(`${row.channel_id}/`) || !TEXT_EXTRACTABLE_EXTENSIONS.has(ext)) {
      skipped++
      continue
    }
    const { data: blob, error: readError } = await service.storage.from(TEAM_CHAT_FILES_BUCKET).download(file.path)
    if (readError || !blob) {
      skipped++
      continue
    }
    let text: string | null = null
    try {
      text = await extract(Buffer.from(await blob.arrayBuffer()), ext)
    } catch {
      text = null
    }
    if (!text) {
      skipped++
      continue
    }
    const chunks = chunkText(text, 3500, MAX_CHAT_FILE_CHUNKS)
    chunks.forEach((chunk, i) =>
      rows.push({ workspace_id: row.workspace_id, channel_id: row.channel_id, message_id: row.id, file_path: file.path, file_name: file.name.slice(0, 200), chunk_index: i, chunk_text: chunk.slice(0, 20000) }),
    )
    indexed++
  }

  // Replace the message's passages whole.
  const { error: clearError } = await service.from('team_chat_file_chunk').delete().eq('message_id', row.id)
  if (clearError) throw new Error(`team chat file index: ${clearError.message}`)
  if (rows.length) {
    const { error: insertError } = await service.from('team_chat_file_chunk').insert(rows)
    if (insertError) throw new Error(`team chat file index: ${insertError.message}`)
  }
  return { indexed, skipped, chunks: rows.length }
}

/** Whether a message's files are worth a job: any the extractor can read. */
export function hasIndexableChatFiles(files: readonly Pick<TeamChatAttachment, 'name'>[] | null | undefined): boolean {
  return (files ?? []).some((f) => TEXT_EXTRACTABLE_EXTENSIONS.has(extensionOf(f.name)))
}
