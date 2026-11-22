'use client'

/**
 * Formatted text on the canvas. What the editor saves is a small document
 * (paragraphs, headings, lists, quotes; bold, italic, underline, strike,
 * code, highlight, links). It is drawn here straight into elements, never as
 * HTML, so nothing a person or an agent wrote can run.
 */
import * as React from 'react'

export interface RichNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
  content?: RichNode[]
}

const SAFE_LINK = /^(https?:|mailto:)/i

function marked(node: RichNode, key: number): React.ReactNode {
  let out: React.ReactNode = node.text ?? ''
  for (const m of node.marks ?? []) {
    if (m.type === 'bold') out = <strong>{out}</strong>
    else if (m.type === 'italic') out = <em>{out}</em>
    else if (m.type === 'underline') out = <u>{out}</u>
    else if (m.type === 'strike') out = <s>{out}</s>
    else if (m.type === 'code') out = <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.9em', background: 'hsl(var(--foreground) / 0.08)', borderRadius: 3, padding: '0 0.25em' }}>{out}</code>
    else if (m.type === 'highlight') out = <mark style={{ background: 'var(--cv-yellow-soft)', color: 'inherit', borderRadius: 2, padding: '0 0.1em' }}>{out}</mark>
    else if (m.type === 'link') {
      const href = typeof m.attrs?.href === 'string' && SAFE_LINK.test(m.attrs.href) ? m.attrs.href : undefined
      out = (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--cv-blue)', textDecoration: 'underline' }}>
          {out}
        </a>
      )
    }
  }
  return <React.Fragment key={key}>{out}</React.Fragment>
}

const HEADING = [1.6, 1.35, 1.15]

function block(node: RichNode, key: number): React.ReactNode {
  const kids = (node.content ?? []).map((c, i) => (c.type === 'text' ? marked(c, i) : block(c, i)))
  switch (node.type) {
    case 'paragraph':
      // An empty paragraph still takes a line.
      return (
        <p key={key} style={{ margin: 0, minHeight: '1.4em' }}>
          {kids}
        </p>
      )
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1))
      return (
        <div key={key} role="heading" aria-level={level} style={{ fontSize: `${HEADING[level - 1]}em`, fontWeight: 600, lineHeight: 1.25, margin: '0 0 0.15em' }}>
          {kids}
        </div>
      )
    }
    case 'bulletList':
      return (
        <ul key={key} style={{ margin: 0, paddingLeft: '1.3em', listStyle: 'disc', textAlign: 'left' }}>
          {kids}
        </ul>
      )
    case 'orderedList':
      return (
        <ol key={key} start={Number(node.attrs?.start) || 1} style={{ margin: 0, paddingLeft: '1.5em', listStyle: 'decimal', textAlign: 'left' }}>
          {kids}
        </ol>
      )
    case 'listItem':
      return <li key={key}>{kids}</li>
    case 'blockquote':
      return (
        <blockquote key={key} style={{ margin: 0, paddingLeft: '0.7em', borderLeft: '3px solid hsl(var(--foreground) / 0.25)', opacity: 0.85, textAlign: 'left' }}>
          {kids}
        </blockquote>
      )
    case 'hardBreak':
      return <br key={key} />
    case 'text':
      return marked(node, key)
    default:
      // A kind this build does not know: its words, plainly.
      return <React.Fragment key={key}>{kids}</React.Fragment>
  }
}

/** Is this a formatted document (as opposed to nothing, or something else)? */
export function isRichDoc(v: unknown): v is RichNode {
  return !!v && typeof v === 'object' && (v as RichNode).type === 'doc' && Array.isArray((v as RichNode).content)
}

export function RichText({ doc }: { doc: RichNode }) {
  return <>{(doc.content ?? []).map((n, i) => block(n, i))}</>
}

/** Does the document say anything plain words could not? (A mark, a heading, a list, a quote.) */
export function hasFormatting(doc: RichNode | undefined): boolean {
  if (!doc) return false
  const walk = (n: RichNode): boolean => {
    if (n.marks?.length) return true
    if (n.type && !['doc', 'paragraph', 'text', 'hardBreak'].includes(n.type)) return true
    return (n.content ?? []).some(walk)
  }
  return walk(doc)
}

/** The document's words, a line per block. */
export function richPlain(doc: RichNode | undefined): string {
  if (!doc) return ''
  const lines: string[] = []
  const inline = (n: RichNode): string => (n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(inline).join(''))
  const walk = (n: RichNode) => {
    if (n.type === 'paragraph' || n.type === 'heading') lines.push(inline(n))
    else for (const c of n.content ?? []) walk(c)
  }
  walk(doc)
  return lines.join('\n')
}

/** Plain words as a document: a paragraph a line. */
export function plainToDoc(plain: string): RichNode {
  return { type: 'doc', content: plain.split('\n').map((line) => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })) }
}
