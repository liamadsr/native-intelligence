'use client'

/**
 * A pull request's cells in the shared list and board (Reviews,
 * docs/plans/github-reviews.md): the row is built by lib/github/reviews-view.ts
 * from what GitHub said. Drawn with the list's own chip (`chipClass`, passed
 * in by entity-row so the two never drift); dates and anything not here fall
 * through to the shared cells. Read-only: GitHub's.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { ChecksIcon, PrStateIcon } from '@/components/chat-cards/pages/reviews/icons'
import type { ReviewPrRow } from '@/lib/github/reviews-view'

const REVIEW_WORD: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
}

const CHECKS_ROLLUP: Record<string, 'SUCCESS' | 'FAILURE' | 'PENDING' | null> = {
  passing: 'SUCCESS',
  failing: 'FAILURE',
  pending: 'PENDING',
  none: null,
}

/** The row's leading glyph: the pull request's state (open, draft, merged, closed). */
export function GithubPrLeading({ item }: { item: Record<string, unknown> }) {
  const row = item as unknown as ReviewPrRow
  return <PrStateIcon pr={{ state: row.state, draft: row.draft }} />
}

/** A cell for `property`, or undefined to let the shared cells draw it. */
export function githubPrCell(property: string, item: Record<string, unknown>, chipClass: string): React.ReactNode | undefined {
  const row = item as unknown as ReviewPrRow
  switch (property) {
    case 'repo':
      return <span className={cn(chipClass, 'max-w-[160px] truncate')}>{row.repo}</span>
    case 'author':
      return row.author ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{row.author}</span> : null
    case 'assignees':
      return row.assignees.length ? <span className={cn(chipClass, 'max-w-[160px] truncate')}>{row.assignees.join(', ')}</span> : null
    case 'review': {
      const word = REVIEW_WORD[row.review]
      if (!word) return null
      return (
        <span
          className={cn(chipClass, row.review === 'approved' && 'text-green-600 dark:text-green-400', row.review === 'changes_requested' && 'text-red-600 dark:text-red-400')}
        >
          {word}
        </span>
      )
    }
    case 'checks': {
      if (row.checks === 'none') return null
      return (
        <span className={chipClass} data-pr-checks={row.checks}>
          <ChecksIcon checks={CHECKS_ROLLUP[row.checks] ?? null} />
          {row.checks === 'passing' ? 'Checks pass' : row.checks === 'failing' ? 'Checks fail' : 'Checks running'}
        </span>
      )
    }
    case 'size':
      return (
        <span className={cn(chipClass, 'tabular-nums')}>
          <span className="text-green-600 dark:text-green-400">+{row.additions}</span>
          <span className="text-red-600 dark:text-red-400">−{row.deletions}</span>
        </span>
      )
    case 'labels':
      return row.labels.length ? (
        <span className="inline-flex items-center gap-1">
          {row.labels.slice(0, 3).map((l) => (
            <span key={l} className={cn(chipClass, 'max-w-[100px] truncate')}>
              {l}
            </span>
          ))}
        </span>
      ) : null
    case 'linked':
      return row.linked.length ? (
        <span className={cn(chipClass, 'font-mono')} title={row.linked.map((a) => `${a.identifier ?? ''} ${a.title ?? ''}`.trim()).join('\n')}>
          {row.linked.map((a) => a.identifier ?? 'Action').slice(0, 2).join(', ')}
          {row.linked.length > 2 ? ` +${row.linked.length - 2}` : ''}
        </span>
      ) : null
    default:
      return undefined
  }
}
