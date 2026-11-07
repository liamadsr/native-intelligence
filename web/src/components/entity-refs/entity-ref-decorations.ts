/**
 * Pure identifier-range finder, shared by the TipTap decoration plugin
 * (entity-ref-tiptap.ts) and its test. Given a string and the document
 * position at which it starts, it returns the ProseMirror ranges that each
 * contain one action identifier.
 *
 * It only FINDS identifier-shaped substrings; whether a range is actually
 * decorated is decided later by the plugin, which keeps only those that
 * resolve to a real action. Keeping this a pure function (no ProseMirror
 * imports) makes it trivial to test.
 */

import { ENTITY_REF_PATTERN } from './types'

export interface EntityRefRange {
  /** Absolute document position of the first character. */
  from: number
  /** Absolute document position just past the last character. */
  to: number
  identifier: string
}

/**
 * Find every identifier in `text`. `offset` is the absolute position of
 * `text[0]` in the document (ProseMirror text-node positions), so the returned
 * ranges are absolute and ready for `Decoration.inline(from, to, …)`.
 */
export function findEntityRefRanges(text: string, offset = 0): EntityRefRange[] {
  const re = new RegExp(ENTITY_REF_PATTERN.source, 'g')
  const ranges: EntityRefRange[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const start = match.index
    ranges.push({
      from: offset + start,
      to: offset + start + match[0].length,
      identifier: match[0],
    })
  }
  return ranges
}
