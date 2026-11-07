/**
 * A long reply, read as the person meets it in the chat: a line or two of talk,
 * then the long, structured part (a story, a summary with sections, a list),
 * then maybe a question back. The chat shows the talk as the reply's bubble,
 * the long part folded into a document they open to read (reply-document.tsx),
 * and the question after it, so a question never hides inside the fold (Liam's
 * reference: "Here's one about…", then the story as a block you open).
 *
 * Pure text in, parts out: no model is asked, so every reply (old ones too)
 * reads the same way, and a short or plain reply stays one bubble.
 */

export interface LongReplyParts {
  /** The talk before the document: a plain paragraph, or null. */
  lead: string | null
  /** The folded part. Null: the reply is short or plain, one bubble as ever. */
  doc: { title: string | null; body: string } | null
  /** A short question after the document, kept out of the fold. */
  tail: string | null
}

/** Below this the body is a reply, not a document. */
const DOC_MIN_CHARS = 500
/** Past this the body folds even as plain paragraphs. */
const DOC_PLAIN_MIN_CHARS = 1200
const LEAD_MAX_CHARS = 400
const TAIL_MAX_CHARS = 300

/** Blocks separated by blank lines, never splitting a fenced code block. */
function blocksOf(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '') {
      if (current.length) blocks.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length) blocks.push(current.join('\n'))
  return blocks
}

const STRUCTURE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---\s*$|\*\*\*\s*$)/m

/** A paragraph of talk: no heading, list, quote, table, code or rule in it. */
function isTalk(block: string, max: number): boolean {
  return block.length <= max && !STRUCTURE.test(block)
}

function headingOf(block: string): string | null {
  const m = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(block)
  return m && !block.includes('\n') ? m[1].replace(/[*_`]/g, '').trim() || null : null
}

export function splitLongReply(text: string): LongReplyParts {
  const plain: LongReplyParts = { lead: null, doc: null, tail: null }
  const blocks = blocksOf(text.trim())
  if (blocks.length < 2) return plain

  let start = 0
  let end = blocks.length
  const lead = isTalk(blocks[0], LEAD_MAX_CHARS) ? blocks[0] : null
  if (lead) start = 1
  // The question back: the whole last paragraph when it is short, or its last
  // sentence when the question ends a longer paragraph of talk.
  let tail: string | null = null
  const last = blocks[end - 1]
  if (end - start > 1 && /\?\s*$/.test(last) && isTalk(last, Infinity)) {
    if (last.length <= TAIL_MAX_CHARS) {
      tail = last
      end -= 1
    } else {
      const sentences = last.split(/(?<=[.!?])\s+(?=["“A-Z])/)
      const question = sentences.at(-1)!
      if (sentences.length > 1 && question.length <= TAIL_MAX_CHARS) {
        tail = question
        blocks[end - 1] = sentences.slice(0, -1).join(' ')
      }
    }
  }

  let title: string | null = null
  if (start < end) {
    title = headingOf(blocks[start])
    if (title) start += 1
  }
  const bodyBlocks = blocks.slice(start, end)
  const body = bodyBlocks.join('\n\n')
  const structured = STRUCTURE.test(body) || bodyBlocks.length >= 3
  const long = body.length >= DOC_PLAIN_MIN_CHARS || (body.length >= DOC_MIN_CHARS && structured)
  if (!long) return plain

  return { lead, doc: { title, body }, tail }
}
