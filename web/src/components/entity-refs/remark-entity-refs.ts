/**
 * remarkEntityRefs — a remark (mdast) plugin that turns bare action
 * identifiers (GEN-297, ENG-42, …) in rendered Markdown into custom
 * `entity-ref` nodes, which the shared Markdown `components` table maps to
 * <EntityRefChip>.
 *
 * It splits `text` nodes on the identifier pattern, leaving the surrounding
 * text intact, and it NEVER touches text inside `code`, `inlineCode` or `link`
 * nodes (a URL or a code sample that happens to contain something
 * identifier-shaped stays verbatim). Resolution — deciding which of these are
 * real actions — happens later, in the chip, so this splitter can over-match
 * freely.
 *
 * The emitted node carries `data.hName` / `data.hProperties`, which
 * mdast-util-to-hast turns into `<entity-ref identifier="GEN-297">` when
 * react-markdown lowers the tree to hast.
 */

import { ENTITY_REF_PATTERN } from './types'

/** Node types whose textual content must be left verbatim. */
const SKIP_TYPES = new Set(['code', 'inlineCode', 'link'])

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
  data?: Record<string, unknown>
  [key: string]: unknown
}

interface TextNode extends MdastNode {
  type: 'text'
  value: string
}

function isText(node: MdastNode): node is TextNode {
  return node.type === 'text' && typeof node.value === 'string'
}

/** Build the custom node for one identifier. */
function entityRefNode(identifier: string): MdastNode {
  return {
    type: 'entityRef',
    data: {
      hName: 'entity-ref',
      hProperties: { identifier },
    },
  }
}

/**
 * Split one text node's value on the identifier pattern into alternating text
 * and entity-ref nodes. Returns null when there's no match (caller keeps the
 * original node untouched).
 */
export function splitTextNode(node: TextNode): MdastNode[] | null {
  const value = node.value
  // Fresh regex per call — the shared one is global/stateful (lastIndex).
  const re = new RegExp(ENTITY_REF_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  let lastIndex = 0
  const out: MdastNode[] = []

  while ((match = re.exec(value)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) })
    }
    out.push(entityRefNode(match[0]))
    lastIndex = end
  }

  if (out.length === 0) return null
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) })
  }
  return out
}

/** Recursively rewrite a node's children, splitting text and skipping code/links. */
function transform(node: MdastNode): void {
  if (!Array.isArray(node.children)) return
  if (SKIP_TYPES.has(node.type)) return

  const next: MdastNode[] = []
  for (const child of node.children) {
    if (isText(child)) {
      const split = splitTextNode(child)
      if (split) next.push(...split)
      else next.push(child)
    } else {
      transform(child)
      next.push(child)
    }
  }
  node.children = next
}

/** The remark plugin. */
export function remarkEntityRefs() {
  return (tree: MdastNode): void => {
    transform(tree)
  }
}

export default remarkEntityRefs
