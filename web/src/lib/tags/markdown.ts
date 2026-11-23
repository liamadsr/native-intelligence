/**
 * A tag typed into text (`#` in an editor), as markdown: a link whose words are
 * `#name` and whose target names the tag,
 *
 *   [#Renewal](tag://6f1c…)
 *
 * so the text stays readable anywhere (an agent sees `#Renewal`), the editor
 * draws it as a pill (components/editor/tag-suggestion.ts), and a save of a
 * record's own text attaches the tags it holds. Pure and client-safe.
 */
import { TAG_NAME_MAX } from './names'

export const TAG_SCHEME = 'tag://'

/** One tag link. Global: walk it with matchAll. */
export const TAG_LINK_RE = /\[#([^\]\n]{1,80})\]\(tag:\/\/([0-9a-fA-F-]{36})\)/g

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TextTag {
  id: string
  name: string
}

/** The words a pill shows, safe inside the link's brackets. */
export function tagLabelText(name: string): string {
  return name.replace(/[[\]#]/g, '').replace(/\s+/g, ' ').trim().slice(0, TAG_NAME_MAX) || 'tag'
}

export function tagMarkdown(tag: TextTag): string {
  return `[#${tagLabelText(tag.name)}](${TAG_SCHEME}${tag.id.toLowerCase()})`
}

/** Fenced code and backtick spans hold code, never a tag. */
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g

/** The tags a text holds, distinct by id, in order (a link inside code is not one). */
export function parseTextTags(markdown: string): TextTag[] {
  const seen = new Map<string, TextTag>()
  for (const m of markdown.replace(CODE_RE, ' ').matchAll(TAG_LINK_RE)) {
    const id = m[2].toLowerCase()
    if (!UUID_RE.test(id) || seen.has(id)) continue
    seen.set(id, { id, name: m[1].trim() })
  }
  return [...seen.values()]
}

/** The tag ids a new text holds that the old one did not: what a save attaches. */
export function addedTextTagIds(before: string | null | undefined, after: string | null | undefined): string[] {
  const had = new Set(parseTextTags(before ?? '').map((t) => t.id))
  return parseTextTags(after ?? '')
    .map((t) => t.id)
    .filter((id) => !had.has(id))
}
