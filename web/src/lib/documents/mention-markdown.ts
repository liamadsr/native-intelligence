/**
 * A record @-mentioned in a document, as its markdown: a link whose words are
 * the `@label` and whose target names the record,
 *
 *   [@Maya Chen](mention://contact/6f1c…)
 *
 * so the body stays readable markdown anywhere (an agent reading the doc sees
 * who and what, with the id), the editor draws it as a chip (note-editor's
 * RecordMention node), and the save turns it into a `mentions` edge
 * (syncDocumentLinks). Pure and client-safe: both halves read this one file.
 */
import { isMentionableType, MENTION_LABEL_MAX, tidyMentionRefs, type MentionRef, type MentionableType } from '@/lib/entity-links/mentionable'

/** The scheme a mention's target is written with. */
export const MENTION_SCHEME = 'mention://'

/** One mention link: `[@label](mention://type/uuid)`. Global: walk it with matchAll. */
export const MENTION_LINK_RE = /\[@([^\]\n]{1,200})\]\(mention:\/\/([a-z_]+)\/([0-9a-fA-F-]{36})\)/g

/** A mention as the editor holds it: the record, and the words its chip shows. */
export interface DocumentMention {
  type: MentionableType
  id: string
  label: string
}

/** The words a chip shows, made safe for the link's brackets: one line, no brackets, capped. */
export function mentionLabelText(label: string): string {
  return label.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, MENTION_LABEL_MAX) || 'Untitled'
}

/** A mention as markdown. */
export function mentionMarkdown(m: DocumentMention): string {
  return `[@${mentionLabelText(m.label)}](${MENTION_SCHEME}${m.type}/${m.id.toLowerCase()})`
}

/** A run of inline text: plain words, or a mention. */
export type MentionTextPart = { kind: 'text'; text: string } | { kind: 'mention'; mention: DocumentMention }

/** Split inline text into its words and its mentions (a link naming no mentionable kind stays words). */
export function splitMentionLinks(text: string): MentionTextPart[] {
  const parts: MentionTextPart[] = []
  let last = 0
  for (const match of text.matchAll(MENTION_LINK_RE)) {
    const [whole, label, type, id] = match
    if (!isMentionableType(type)) continue
    const at = match.index ?? 0
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) })
    parts.push({ kind: 'mention', mention: { type, id: id.toLowerCase(), label: label.trim() } })
    last = at + whole.length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts.length ? parts : [{ kind: 'text', text }]
}

/** The records a body mentions, distinct (tidied: mentionable kinds, well-formed ids, capped). */
export function parseDocumentMentions(markdown: string): MentionRef[] {
  const raw: Array<{ type: string; id: string }> = []
  for (const match of markdown.matchAll(MENTION_LINK_RE)) raw.push({ type: match[2], id: match[3] })
  return tidyMentionRefs(raw)
}
