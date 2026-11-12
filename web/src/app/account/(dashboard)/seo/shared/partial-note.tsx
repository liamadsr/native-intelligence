/**
 * The quiet line a paid answer carries when part of it could not be read
 * (`partial` on a keyword research or a site overview): what came back was
 * paid for and is shown, and this says, in the server's own plain sentence,
 * what is missing. Not an error and not a toast: a muted line beside the
 * result's own line, the page's Refresh still there to ask again.
 *
 * Draws nothing when the answer is whole.
 */
import type { PartialAnswer } from '@/lib/seo/keywords/view'
import { cn } from '@/lib/utils'

/** The note to show, trimmed; null when the answer is whole. */
export function partialNoteText(partial: PartialAnswer | null | undefined): string | null {
  const note = typeof partial?.note === 'string' ? partial.note.trim() : ''
  return note ? note : null
}

export function PartialNote({ partial, className }: { partial: PartialAnswer | null | undefined; className?: string }) {
  const note = partialNoteText(partial)
  if (!note) return null
  return (
    <p data-seo-partial="" className={cn('text-xs leading-relaxed text-muted-foreground', className)}>
      {note}
    </p>
  )
}
