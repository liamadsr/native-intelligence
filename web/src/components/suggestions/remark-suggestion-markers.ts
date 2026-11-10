/**
 * remark plugin: `<!-- proposal:ID -->` markers become suggestion cards in any
 * react-markdown surface (chat answers, the knowledge library, briefs shown as
 * markdown). The TipTap side is ProposalNodeExtension; the server side is
 * reconcile-markers.ts.
 *
 * Without this, react-markdown renders an HTML comment as literal text. With
 * it, a marker becomes a `ni-suggestion` element (mapped to SuggestionCard
 * in the markdown components):
 *   • a marker on its own line is a block of its own: the card takes its place;
 *   • a marker inside a paragraph ("…close it. <!-- proposal:… -->") is moved
 *     to just after that paragraph, since a card is a block and can't sit
 *     inside a <p>.
 * Any other HTML comment (`<!-- card:2 -->`, `<!-- note -->`: the model
 * sometimes copies the marker shape for things that aren't proposals) is
 * dropped: a comment is never meant to be seen, and react-markdown would
 * otherwise print it as literal text. Every other HTML node is left alone.
 */

const MARKER_RE = /<!--\s*proposal:([a-zA-Z0-9-]+)\s*-->/g
/** Non-global, for .test() (a global regex keeps lastIndex between calls). */
const HAS_MARKER_RE = /<!--\s*proposal:[a-zA-Z0-9-]+\s*-->/
/**
 * An html node that is nothing but comments (any comment, proposal markers
 * included). Each comment's body can't contain `-->`, so a failed match can't
 * re-split the input: linear, not exponential, on long replies.
 */
const ONLY_COMMENTS_RE = /^\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)+$/

export const SUGGESTION_ELEMENT = 'ni-suggestion'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

function suggestionNode(id: string): MdNode {
  return {
    type: 'suggestionMarker',
    data: { hName: SUGGESTION_ELEMENT, hProperties: { 'data-suggestion-id': id } },
  }
}

function idsIn(value: string): string[] {
  return [...value.matchAll(MARKER_RE)].map((m) => m[1])
}

/** Marker ids in a markdown string, in order (the chat uses it to know which cards a message placed). */
export function markerIdsIn(markdown: string): string[] {
  return idsIn(markdown)
}

/**
 * Markers, and any other one-line HTML comment, out of text meant for plain
 * display (copy, read-aloud, previews). It lives in src/lib, beside the SMS and
 * Slack formatting that use it too.
 */
export { stripHtmlComments as stripSuggestionMarkers } from '@/lib/chat/strip-comments'

function transform(parent: MdNode): void {
  const children = parent.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    // A block that is only comments: proposal markers become cards, any other
    // comment (a stray `<!-- card:2 -->`) is dropped.
    if (node.type === 'html' && typeof node.value === 'string' && ONLY_COMMENTS_RE.test(node.value)) {
      const replacement = idsIn(node.value).map(suggestionNode)
      children.splice(i, 1, ...replacement)
      i += replacement.length - 1
      continue
    }
    // A paragraph carrying inline markers or comments: lift the markers out to
    // after it as cards, and drop the comments.
    const isComment = (c: MdNode) => c.type === 'html' && typeof c.value === 'string' && ONLY_COMMENTS_RE.test(c.value)
    const hasMarker = (c: MdNode) => c.type === 'html' && HAS_MARKER_RE.test(c.value ?? '')
    if (node.type === 'paragraph' && node.children?.some((c) => hasMarker(c) || isComment(c))) {
      const lifted: MdNode[] = []
      node.children = node.children.filter((c) => {
        if (c.type !== 'html' || typeof c.value !== 'string') return true
        const ids = idsIn(c.value)
        if (ids.length === 0 && !isComment(c)) return true
        lifted.push(...ids.map(suggestionNode))
        return false
      })
      // Drop a trailing line break the marker's own line left behind.
      while (node.children.length && node.children[node.children.length - 1].type === 'break') node.children.pop()
      const last = node.children[node.children.length - 1]
      if (last?.type === 'text' && typeof last.value === 'string') last.value = last.value.replace(/\s+$/, '')
      const keepParagraph = node.children.length > 0
      children.splice(i, 1, ...(keepParagraph ? [node] : []), ...lifted)
      i += (keepParagraph ? 1 : 0) + lifted.length - 1
      continue
    }
    if (node.children) transform(node)
  }
}

export function remarkSuggestionMarkers() {
  return (tree: MdNode) => transform(tree)
}
