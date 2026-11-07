/**
 * remark plugin: `<!-- proposal:ID -->` markers become suggestion cards in any
 * react-markdown surface (chat answers, the knowledge library, briefs shown as
 * markdown). The TipTap side is ProposalNodeExtension; the server side is
 * reconcile-markers.ts.
 *
 * Without this, react-markdown renders an HTML comment as literal text. With
 * it, a marker becomes a `dial8-suggestion` element (mapped to SuggestionCard
 * in the markdown components):
 *   • a marker on its own line is a block of its own: the card takes its place;
 *   • a marker inside a paragraph ("…close it. <!-- proposal:… -->") is moved
 *     to just after that paragraph, since a card is a block and can't sit
 *     inside a <p>.
 * Every other HTML node is left alone.
 */

const MARKER_RE = /<!--\s*proposal:([a-zA-Z0-9-]+)\s*-->/g
/** Non-global, for .test() (a global regex keeps lastIndex between calls). */
const HAS_MARKER_RE = /<!--\s*proposal:[a-zA-Z0-9-]+\s*-->/
const ONLY_MARKERS_RE = /^(\s*<!--\s*proposal:[a-zA-Z0-9-]+\s*-->\s*)+$/

export const SUGGESTION_ELEMENT = 'dial8-suggestion'

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

/** Remove markers from text meant for plain display (copy, read-aloud, previews). */
export function stripSuggestionMarkers(markdown: string): string {
  return markdown.replace(/[ \t]*<!--\s*proposal:[a-zA-Z0-9-]+\s*-->[ \t]*\n?/g, '')
}

function transform(parent: MdNode): void {
  const children = parent.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    // A block-level marker (its own html node, only markers in it).
    if (node.type === 'html' && typeof node.value === 'string' && ONLY_MARKERS_RE.test(node.value)) {
      const replacement = idsIn(node.value).map(suggestionNode)
      children.splice(i, 1, ...replacement)
      i += replacement.length - 1
      continue
    }
    // A paragraph carrying inline markers: lift them out to after it.
    if (node.type === 'paragraph' && node.children?.some((c) => c.type === 'html' && HAS_MARKER_RE.test(c.value ?? ''))) {
      const lifted: MdNode[] = []
      node.children = node.children.filter((c) => {
        if (c.type !== 'html' || typeof c.value !== 'string') return true
        const ids = idsIn(c.value)
        if (ids.length === 0) return true
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
