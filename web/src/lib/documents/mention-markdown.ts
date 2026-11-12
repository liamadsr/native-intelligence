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
import { MENTION_LABEL_MAX, tidyMentionRefs, type MentionRef, type MentionableType } from '@/lib/entity-links/mentionable'

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

/** Fenced code blocks and backtick spans: their text is code, never a mention (as the editor reads it). */
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g

/**
 * The records a body mentions, distinct, in order (mentionable kinds,
 * well-formed ids; a link inside code is not one). Not capped: the caller
 * decides how many it keeps.
 */
export function parseDocumentMentions(markdown: string): MentionRef[] {
  const seen = new Map<string, MentionRef>()
  for (const match of markdown.replace(CODE_RE, ' ').matchAll(MENTION_LINK_RE)) {
    const [ref] = tidyMentionRefs([{ type: match[2], id: match[3] }])
    if (ref && !seen.has(`${ref.type}:${ref.id}`)) seen.set(`${ref.type}:${ref.id}`, ref)
  }
  return [...seen.values()]
}
