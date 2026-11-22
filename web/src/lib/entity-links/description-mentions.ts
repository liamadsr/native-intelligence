/**
 * `@` MENTIONS IN A RECORD'S DESCRIPTION OR NOTES (docs/plans/mentions-everywhere.md):
 * the NoteEditor fields — an action's, a project's and an initiative's
 * description, a contact's notes, a capture's notes (its `ai_summary`, the
 * capture page's editor) — save as markdown holding the same chips a
 * document does (`[@Maya Chen](mention://contact/<id>)`,
 * src/lib/documents/mention-markdown.ts). On save, this makes the record's
 * outbound `mentions` edges match what its text names now, through the shared
 * mention helper (src/lib/entity-links/mentions.ts), exactly as
 * `syncDocumentLinks` does for a document: what the text names is added (fenced
 * for the editor), and only what the OLD text named and the new one doesn't is
 * taken back (`removable`), so an edge drawn elsewhere is never touched.
 *
 * A teammate newly mentioned (a contact linked to a member) is told once
 * (notifyRecordMentions). Server only. A mention is never worth failing the
 * save it rides: nothing here throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseDocumentMentions } from '@/lib/documents/mention-markdown'
import { mentionKey } from '@/lib/entity-links/mentionable'
import { syncMentions } from '@/lib/entity-links/mentions'
import { DOCUMENT_MENTION_KINDS } from '@/lib/wiki/wikilinks'
import { notifyRecordMentions, type MentionNotificationTargetType } from '@/lib/documents/mention-notifications'
import { shareMentionedMail } from '@/lib/email-share/share-on-mention'

export interface SyncDescriptionMentionsInput {
  workspaceId: string
  /** The record whose description/notes this is (its kind and id). */
  source: { type: MentionNotificationTargetType; id: string }
  /** The saved text (markdown). */
  markdown: string
  /** The text before this save, to take back only what it named and the new text doesn't. Absent: nothing taken back. */
  previousMarkdown?: string | null
  /** The editor (their private records may be mentioned); their member row is resolved from it when `memberId` is absent. */
  userId: string | null
  /** The editor's member row (entity_link.created_by, and the mention's actor), or resolved from `userId`. */
  memberId?: string | null
  /** How the record is named in the teammate's notification (its title); absent falls back to "a task"/"a note"/… */
  title?: string | null
  /**
   * For a record only some teammates can open (a private capture): a teammate
   * who is not `createdBy` (a member id) is not told. The edges are written
   * either way; they are fenced for each reader like any other.
   */
  gate?: { visibility: string | null; createdBy: string | null }
}

/** Make `source`'s mention edges match its description/notes now, and tell a newly-mentioned teammate. Never throws. */
export async function syncDescriptionMentions(supabase: SupabaseClient, input: SyncDescriptionMentionsInput): Promise<void> {
  try {
    const chips = parseDocumentMentions(input.markdown)
    const named = new Set(chips.map(mentionKey))
    // The only edges a save may take back: what the OLD text named and the new text doesn't.
    const removable = input.previousMarkdown
      ? parseDocumentMentions(input.previousMarkdown).filter((r) => !named.has(mentionKey(r)))
      : []
    // Nothing named now and nothing to take back: no read, no write.
    if (chips.length === 0 && removable.length === 0) return

    let memberId = input.memberId ?? null
    if (!memberId && input.userId) {
      const { data } = await supabase.from('member').select('id').eq('user_id', input.userId).eq('workspace_id', input.workspaceId).maybeSingle()
      memberId = (data as { id?: string } | null)?.id ?? null
    }

    const result = await syncMentions(supabase, {
      workspaceId: input.workspaceId,
      source: input.source,
      targets: chips,
      userId: input.userId,
      memberId,
      // Only the kinds a chip can name (the one `@` picker's, a deal as its row).
      kinds: DOCUMENT_MENTION_KINDS,
      removable,
    })
    if (result.error) {
      console.warn(`[description-mentions] edges for ${input.source.type}=${input.source.id} failed:`, result.error)
      return
    }

    // A teammate newly @-mentioned is told, once (decision 4).
    const people = (result.fresh ?? []).filter((r) => r.type === 'contact').map((r) => r.id)
    if (people.length && memberId) {
      await notifyRecordMentions(supabase, {
        workspaceId: input.workspaceId,
        authorMemberId: memberId,
        target: { type: input.source.type, id: input.source.id, title: input.title ?? null },
        contactIds: people,
        ...(input.gate ? { gate: input.gate } : {}),
      })
    }

    // The author's OWN mail thread, mentioned beside a teammate in this text,
    // is shared with that teammate (decision 1), by the same rule as comments.
    // Only pairs new since `previousMarkdown` are shared, so an unchanged
    // re-save makes no provider call. Removing the mention later does NOT
    // revoke the share (only the owner's explicit revoke does).
    await shareMentionedMail(supabase, {
      workspaceId: input.workspaceId,
      authorUserId: input.userId,
      authorMemberId: memberId,
      mentions: chips,
      previousMentions: input.previousMarkdown ? parseDocumentMentions(input.previousMarkdown) : null,
      source: { type: input.source.type, id: input.source.id },
    })
  } catch (err) {
    console.warn('[description-mentions] sync threw:', err instanceof Error ? err.message : 'unknown')
  }
}
