'use client'

/**
 * Read-along (spike, Liam 10-25): while Dial8 reads aloud, the HUD shows the
 * word being said, one at a time, flipping past in step with the voice. Each
 * word centred, clean of the punctuation round it (a comma or a quote on its
 * own reads as noise at that pace). The desktop sends each word a moment
 * before it's heard (`tts://word`; desktop audio/word_marks.rs).
 */
import { cn } from '@/lib/utils'
import type React from 'react'

/**
 * The word as shown: the punctuation round it dropped (quotes, brackets,
 * commas, full stops, markdown's asterisks), what's part of it kept ("don't",
 * "well-known", "3.5", "$40", "20%", "U.S."). Empty when it's all punctuation.
 */
export function cleanWord(word: string): string {
  const core = word.replace(/^[^\p{L}\p{N}$£€#@]+/u, '').replace(/[^\p{L}\p{N}%]+$/u, '')
  if (!/[\p{L}\p{N}]/u.test(core)) return ''
  // An abbreviation's last full stop is part of it: "U.S." not "U.S".
  if (/^(\p{L}\.)+\p{L}$/u.test(core) && /[\p{L}]\.\W*$/u.test(word)) return `${core}.`
  return core
}

/** A font size (px) that fits the word in `width` px on one line, never over `max`. */
export function fitSize(word: string, width: number, max: number): number {
  const letters = [...cleanWord(word)].length || 1
  return Math.min(max, Math.floor(width / (letters * 0.6)))
}

export function ReadAlongWord({ word, className, style }: { word: string; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      data-testid="read-along"
      className={cn('w-full overflow-hidden text-center font-medium tracking-tight whitespace-nowrap', className)}
      style={style}
    >
      {cleanWord(word)}
    </div>
  )
}
