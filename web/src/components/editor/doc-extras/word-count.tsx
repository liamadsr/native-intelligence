'use client'

/**
 * A document's live word and character count (docs/plans/doc-editor-extras.md,
 * phase 6), under the text: the whole document's, or the selection's while
 * there is one. Characters count what is written (spaces included, line
 * breaks not); a formula or a record chip counts as one word.
 */
import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

export interface TextCounts {
  words: number
  characters: number
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’.\-_][\p{L}\p{N}]+)*/gu
// Han, Hiragana, Katakana and Hangul are written without spaces: each character is a word.
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_ALL_RE = new RegExp(CJK_RE.source, 'gu')

/** Words and characters in a piece of text. Pure. */
export function countText(text: string): TextCounts {
  let words = 0
  for (const m of text.match(WORD_RE) ?? []) {
    if (!CJK_RE.test(m)) {
      words++
      continue
    }
    // Each CJK character, plus each run of other letters between them.
    words += [...m].filter((c) => CJK_RE.test(c)).length
    words += m.replace(CJK_ALL_RE, ' ').split(/\s+/).filter(Boolean).length
  }
  return { words, characters: [...text.replace(/\n/g, '')].length }
}

/** The counts for a document range (an inline atom reads as one word, `•`). */
export function countRange(doc: PMNode, from: number, to: number): TextCounts {
  return countText(doc.textBetween(from, to, '\n', '•'))
}

const fmt = (n: number) => n.toLocaleString()

export function WordCount({ editor, className }: { editor: Editor | null; className?: string }) {
  const [counts, setCounts] = useState<{ all: TextCounts; selected: TextCounts | null } | null>(null)

  useEffect(() => {
    if (!editor) {
      setCounts(null)
      return
    }
    let frame = 0
    const measure = () => {
      frame = 0
      if (editor.isDestroyed) return
      const { doc, selection } = editor.state
      const all = countRange(doc, 0, doc.content.size)
      const selected = selection.empty ? null : countRange(doc, selection.from, selection.to)
      setCounts((cur) =>
        cur &&
        cur.all.words === all.words &&
        cur.all.characters === all.characters &&
        cur.selected?.words === selected?.words &&
        cur.selected?.characters === selected?.characters
          ? cur
          : { all, selected },
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    editor.on('transaction', schedule)
    return () => {
      editor.off('transaction', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor])

  if (!counts) return null
  const shown = counts.selected ?? counts.all
  return (
    <p className={className} aria-live="off" data-testid="word-count">
      {counts.selected ? 'Selected: ' : ''}
      {fmt(shown.words)} {shown.words === 1 ? 'word' : 'words'} · {fmt(shown.characters)} {shown.characters === 1 ? 'character' : 'characters'}
    </p>
  )
}
