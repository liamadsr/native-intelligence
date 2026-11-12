/**
 * What pasting a URL on its own does in the editor (NoteEditor's handlePaste):
 *   • on an empty line: a link preview card, and a line after it to keep
 *     typing on (a table's link: the table itself, embedded: lib/tables/embed.ts);
 *   • over text selected within one line: that text becomes the link;
 *   • anywhere else: the URL goes in where it was pasted, as a link.
 * It used to drop the card at the END of the document whenever the line wasn't
 * empty, far from where the person pasted.
 *
 * Returns null where the editor's own paste should run instead (a code block,
 * a schema without links or cards).
 */

import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Selection } from '@tiptap/pm/state'
import { parseTableLink } from '@/lib/tables/embed'

export function pasteUrlTransaction(state: EditorState, url: string): Transaction | null {
  const { schema, selection } = state
  const linkPreview = schema.nodes.linkPreview
  const link = schema.marks.link
  const { $from, $to, from, to, empty } = selection

  // Selected text within one line: link it.
  if (!empty && link && $from.sameParent($to) && $from.parent.inlineContent) {
    if (!$from.parent.type.allowsMarkType(link)) return null
    return state.tr.addMark(from, to, link.create({ href: url }))
  }

  const tr = state.tr.deleteRange(from, to)
  const $pos = tr.doc.resolve(tr.mapping.map(from))

  // An empty line: the card, then a fresh line under it.
  const tableEmbed = schema.nodes.tableEmbed
  const table = tableEmbed ? parseTableLink(url) : null
  if ((linkPreview || table) && $pos.parent.type.name === 'paragraph' && $pos.parent.textContent === '') {
    const card = table ? tableEmbed.create({ tableId: table.tableId, viewId: table.viewId }) : linkPreview.create({ url })
    const start = $pos.before($pos.depth)
    const end = $pos.after($pos.depth)
    tr.replaceRangeWith(start, end, card)
    const after = start + card.nodeSize
    tr.insert(after, schema.nodes.paragraph.create())
    tr.setSelection(Selection.near(tr.doc.resolve(after + 1)))
    return tr
  }

  // Mid-line: the URL as a link, where it was pasted. Typing on after it
  // isn't part of the link.
  if (!link || !$pos.parent.inlineContent || !$pos.parent.type.allowsMarkType(link)) return null
  tr.replaceSelectionWith(schema.text(url, [link.create({ href: url })]), false)
  tr.removeStoredMark(link)
  return tr
}
