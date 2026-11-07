import { describe, it, expect } from 'vitest'
import { remarkEntityRefs, splitTextNode } from '../remark-entity-refs'

interface Node {
  type: string
  value?: string
  children?: Node[]
  data?: { hName?: string; hProperties?: { identifier?: string } }
  [key: string]: unknown
}

interface TextNode extends Node {
  type: 'text'
  value: string
}

function text(value: string): TextNode {
  return { type: 'text', value }
}

/** The identifier of an entity-ref node, or null if `node` isn't one. */
function refOf(node: Node): string | null {
  if (node.type !== 'entityRef') return null
  return node.data?.hProperties?.identifier ?? null
}

describe('splitTextNode', () => {
  it('splits a single identifier out of surrounding text', () => {
    const out = splitTextNode(text('See GEN-297 now'))!
    expect(out.map((n) => n.type)).toEqual(['text', 'entityRef', 'text'])
    expect((out[0] as Node).value).toBe('See ')
    expect(refOf(out[1] as Node)).toBe('GEN-297')
    expect((out[2] as Node).value).toBe(' now')
  })

  it('splits multiple identifiers on one line', () => {
    const out = splitTextNode(text('GEN-1 and ENG-2 then ABC12-9'))!
    const refs = out.map(refOf).filter((r): r is string => r !== null)
    expect(refs).toEqual(['GEN-1', 'ENG-2', 'ABC12-9'])
  })

  it('emits the entity-ref node with the hName/hProperties the renderer needs', () => {
    const out = splitTextNode(text('GEN-5'))!
    expect(out).toHaveLength(1)
    expect(out[0].data).toEqual({
      hName: 'entity-ref',
      hProperties: { identifier: 'GEN-5' },
    })
  })

  it('returns null when there is no identifier', () => {
    expect(splitTextNode(text('just some prose, 2024, v1.2'))).toBeNull()
  })

  it('does not match a lowercase prefix', () => {
    expect(splitTextNode(text('gen-1'))).toBeNull()
  })
})

describe('remarkEntityRefs', () => {
  const run = (tree: Node) => {
    remarkEntityRefs()(tree)
    return tree
  }

  it('splits text inside a paragraph', () => {
    const tree: Node = {
      type: 'root',
      children: [{ type: 'paragraph', children: [text('Ship GEN-42 today')] }],
    }
    const para = run(tree).children![0]
    expect(para.children!.map((n) => n.type)).toEqual(['text', 'entityRef', 'text'])
    expect(refOf(para.children![1])).toBe('GEN-42')
  })

  it('leaves text inside a link untouched', () => {
    const link: Node = { type: 'link', children: [text('GEN-1')] }
    const tree: Node = {
      type: 'root',
      children: [{ type: 'paragraph', children: [text('before GEN-2 '), link] }],
    }
    const para = run(tree).children![0]
    // The bare text was split…
    expect(refOf(para.children![1])).toBe('GEN-2')
    // …but the link's content is still a single, unmodified text node.
    const linkNode = para.children!.find((n) => n.type === 'link')!
    expect(linkNode.children).toHaveLength(1)
    expect(linkNode.children![0].type).toBe('text')
    expect(linkNode.children![0].value).toBe('GEN-1')
  })

  it('leaves inline code and code blocks untouched', () => {
    const tree: Node = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [text('run '), { type: 'inlineCode', value: 'GEN-9' }] },
        { type: 'code', value: 'const x = "GEN-7"' },
      ],
    }
    const root = run(tree)
    const para = root.children![0]
    // inlineCode is a leaf with a value, not split.
    const code = para.children!.find((n) => n.type === 'inlineCode')!
    expect(code.value).toBe('GEN-9')
    expect(para.children!.some((n) => n.type === 'entityRef')).toBe(false)
    // The code block is wholly untouched.
    expect(root.children![1].value).toBe('const x = "GEN-7"')
  })
})
