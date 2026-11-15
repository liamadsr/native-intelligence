/**
 * One line of a line diff. Two variants:
 *   document  as the document history draws it (the default, unchanged):
 *             added green, removed red and struck, a sign before the text,
 *             wrapping under it;
 *   code      the Changes view of a Mac job's branch (components/local-agent/
 *             changes-view.tsx): a grid row with the old and new line numbers
 *             and the sign in fixed columns, the code wrapping inside its own
 *             column (so a continuation never reads as an unnumbered line),
 *             the row's tint covering all of its lines, and a removed line
 *             tinted only (a strike makes code hard to read).
 */
import type { ReactNode } from 'react'
import type { DiffLine } from '@/lib/documents/line-diff'
import { cn } from '@/lib/utils'

export type DiffLineVariant = 'document' | 'code'

const TINT: Record<DiffLine['kind'], string> = {
  same: '',
  added: 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200',
  removed: 'bg-rose-500/10 text-rose-900 dark:text-rose-200',
}

export function diffLineClass(kind: DiffLine['kind'], variant: DiffLineVariant = 'document'): string {
  if (variant === 'code') return cn('grid grid-cols-[2.25rem_2.25rem_1.25rem_minmax(0,1fr)]', TINT[kind])
  return cn('whitespace-pre-wrap break-words px-3', TINT[kind], kind === 'removed' && 'line-through decoration-rose-500/40')
}

export function diffSign(kind: DiffLine['kind']): string {
  return kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '
}

/** The fold between kept lines: "12 unchanged lines". */
export function DiffFoldRow({ children }: { children: ReactNode }) {
  return <div className="bg-muted/40 px-3 py-0.5 font-sans text-[11px] text-muted-foreground">{children}</div>
}

export function DiffLineRow({
  kind,
  text,
  variant = 'document',
  oldLine,
  newLine,
  className,
}: {
  kind: DiffLine['kind']
  text: string
  variant?: DiffLineVariant
  /** The code variant's line numbers. */
  oldLine?: number
  newLine?: number
  className?: string
}) {
  if (variant === 'code') {
    return (
      <div data-diff-row={kind} className={cn(diffLineClass(kind, 'code'), className)}>
        <span className="select-none pr-1 text-right tabular-nums text-muted-foreground/70">{oldLine ?? ''}</span>
        <span className="select-none pr-1 text-right tabular-nums text-muted-foreground/70">{newLine ?? ''}</span>
        <span className="select-none text-center text-muted-foreground">{diffSign(kind)}</span>
        <span className="min-w-0 whitespace-pre-wrap pr-3 [overflow-wrap:anywhere]">{text || ' '}</span>
      </div>
    )
  }
  return (
    <div data-diff-row={kind} className={cn(diffLineClass(kind), className)}>
      <span className="select-none pr-2 text-muted-foreground">{diffSign(kind)}</span>
      {text || ' '}
    </div>
  )
}
