/**
 * Incremental sentence splitter for a reply that is still streaming.
 *
 * Feed `push()` the whole text of the reply so far, as often as it grows; it
 * returns only the sentences completed since the last call. `flush()` returns
 * the rest once the stream has ended. Concatenated, everything it returns is
 * exactly `markdownToSentences(finalText)`, so auto-read and the per-message
 * speaker button say the same thing.
 *
 * A sentence is complete when the text after it has started (the next
 * sentence, or the next block). The last sentence of the block being written
 * waits for that, and nothing is read from inside an unclosed code fence or a
 * table still being written.
 *
 * Block structure is decided only from finished lines: the partial last line
 * can extend the open block (so a long one-line paragraph is read sentence by
 * sentence), but it never closes one, because "1" / "1." / "1.5 million"
 * mean three different things until the line is done.
 *
 * Likewise an inline construct still arriving at the end of the open block (a
 * `<https://…` or `<em` with no `>` yet, a trailing `~`, a half-typed `&amp`,
 * a `[^1` footnote marker, a link title)
 * is held back: rewriting it once complete can change the character after a
 * period, and so whether a sentence ended there.
 */

import {
  blockToSpeech,
  parseSpeechBlocksWithState,
  splitLongSentence,
  splitSentencesRaw,
  type SpeechBlock,
} from './speech-text'

export class SentenceStream {
  private text = ''
  /** Blocks whose every sentence has been returned. */
  private doneBlocks = 0
  /** Raw sentences already returned from block `doneBlocks` (still open). */
  private doneInBlock = 0
  private finished = false

  /** The reply's full text so far → sentences completed since the last call. */
  push(text: string): string[] {
    if (this.finished) return []
    this.text = text
    return this.drain(false)
  }

  /** The stream ended: everything not yet returned. Later calls return []. */
  flush(): string[] {
    if (this.finished) return []
    this.finished = true
    return this.drain(true)
  }

  private drain(final: boolean): string[] {
    const { blocks } = parseSpeechBlocksWithState(this.text)

    // How many leading blocks are final. Only finished lines count; a
    // trailing newline alone isn't a blank line, so it is cut off first.
    let closed = blocks.length
    if (!final) {
      const lastNewline = this.text.lastIndexOf('\n')
      const finishedLines = lastNewline < 0 ? '' : this.text.slice(0, lastNewline)
      const settled = lastNewline < 0 ? { blocks: [], lastOpen: false } : parseSpeechBlocksWithState(finishedLines)
      closed = settled.lastOpen ? settled.blocks.length - 1 : settled.blocks.length
    }

    const out: string[] = []
    for (let i = this.doneBlocks; i < blocks.length; i++) {
      const already = i === this.doneBlocks ? this.doneInBlock : 0
      const raw = splitSentencesRaw(blockToSpeech(blocks[i]))

      if (i < closed) {
        out.push(...raw.slice(already).flatMap(splitLongSentence))
        this.doneBlocks = i + 1
        this.doneInBlock = 0
        continue
      }

      // The open block (never reached on flush): its last sentence may still
      // be growing, and an unfinished inline construct may still change it.
      const growing = splitSentencesRaw(blockToSpeech(withoutUnfinishedInline(blocks[i])))
      if (!mayHoldTable(blocks[i]) && growing.length - 1 > already) {
        out.push(...growing.slice(already, -1).flatMap(splitLongSentence))
        this.doneInBlock = growing.length - 1
      }
      // A block the partial line started stays unread until its line is done.
      break
    }
    return out
  }
}

/**
 * The open block minus an inline construct that is still arriving at its end:
 * from the last `<` that starts a tag, comment or autolink and has no `>`
 * after it, a trailing run of `~` (strikethrough), a trailing `&entity`
 * without its `;`, a footnote marker without its `]`, or a link whose
 * `"title"` has started but not its `)` (the whole marker or link destination
 * is dropped once complete). Closed code spans are ignored ("`a<b`" holds
 * nothing back).
 */
function withoutUnfinishedInline(block: SpeechBlock): SpeechBlock {
  const text = block.lines.join(' ')
  const masked = text.replace(/(`+)([^`]+?)\1/g, (m) => ' '.repeat(m.length))
  let cut = text.length
  const tag = /<(?:[A-Za-z!/][^<>]*)?$/.exec(masked)
  if (tag) cut = tag.index
  const tail = /(?:~+|&[A-Za-z0-9#]*|\[\^[^\]\s]*|\]\((?:[^()\s]|\([^)]*\))*\s+"[^"]*"?)$/.exec(masked.slice(0, cut))
  if (tail) cut = tail.index
  return cut === text.length ? block : { ...block, lines: [text.slice(0, cut)] }
}

/** A one-line paragraph with a pipe may become a table header on the next line. */
function mayHoldTable(block: SpeechBlock): boolean {
  return block.kind === 'text' && block.lines.length === 1 && block.lines[0].includes('|')
}
