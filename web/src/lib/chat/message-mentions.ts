/**
 * WHAT A SENT CHAT MESSAGE @-MENTIONS (docs/plans/mentions-everywhere.md,
 * 3.4): the records the composer's chips named when it was sent, kept on the
 * message in the one mention format (`metadata.mentions: [{ type, id,
 * label }]`), so its `@label` words stay chips that open the record after the
 * composer has cleared, and on reload.
 *
 * The client writes it and the chat's save parses it again (persist-eve-turn
 * userMessageOf). It is drawing only: what the agent reads rides the turn's
 * system context, fenced on the server. Old messages carry none and stay
 * plain words. Pure and client-safe.
 */
import { tidyLabeledMentionRefs, type LabeledMentionRef, type MentionableType } from '@/lib/entity-links/mentionable'
import { FINDABLE } from '@/lib/search/findable-registry'
import { mentionRecordLabel, type MentionRecord } from '@/lib/search/menu-search'

/** What the composer held at send, as mentions: captures, people, companies, then the records. */
export function turnMessageMentions(turn: {
  notes?: ReadonlyArray<{ id: string; title?: string | null }>
  contacts?: ReadonlyArray<{ id: string; full_name?: string | null; email?: string | null }>
  companies?: ReadonlyArray<{ id: string; name: string }>
  records?: readonly MentionRecord[]
}): LabeledMentionRef[] {
  return tidyLabeledMentionRefs([
    ...(turn.notes ?? []).map((n) => ({ type: 'capture', id: n.id, label: n.title ?? '' })),
    ...(turn.contacts ?? []).map((c) => ({ type: 'contact', id: c.id, label: c.full_name || c.email || '' })),
    ...(turn.companies ?? []).map((c) => ({ type: 'company', id: c.id, label: c.name })),
    ...(turn.records ?? []).map((r) => ({ type: FINDABLE[r.kind].mention as MentionableType, id: r.id, label: mentionRecordLabel(r) })),
  ])
}

/** The metadata a message carries for them (nothing when it mentions none). */
export function messageMentionsMetadata(mentions: readonly LabeledMentionRef[]): { mentions?: LabeledMentionRef[] } {
  return mentions.length ? { mentions: [...mentions] } : {}
}

/** The mentions a message's metadata carries, checked: the client wrote it. */
export function messageMentionsOfMetadata(metadata: unknown): LabeledMentionRef[] {
  if (!metadata || typeof metadata !== 'object') return []
  return tidyLabeledMentionRefs((metadata as { mentions?: unknown }).mentions)
}
