'use client'

/** The Reviews page's small icons: a pull request's state, and its checks' rollup. */
import { CircleCheck, CircleDot, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReviewPr } from '@/lib/github/reviews'

export function PrStateIcon({ pr, className }: { pr: Pick<ReviewPr, 'state' | 'draft'>; className?: string }) {
  const cls = cn('size-4 shrink-0', className)
  if (pr.state === 'merged') return <GitMerge aria-label="Merged" className={cn(cls, 'text-purple-500')} />
  if (pr.state === 'closed') return <GitPullRequestClosed aria-label="Closed" className={cn(cls, 'text-red-500')} />
  if (pr.draft) return <GitPullRequestDraft aria-label="Draft" className={cn(cls, 'text-muted-foreground')} />
  return <GitPullRequest aria-label="Open" className={cn(cls, 'text-green-500')} />
}

export function ChecksIcon({ checks }: { checks: ReviewPr['checks'] }) {
  if (checks === 'SUCCESS') return <CircleCheck aria-label="Checks passing" className="size-3.5 text-green-500" />
  if (checks === 'FAILURE' || checks === 'ERROR') return <CircleX aria-label="Checks failing" className="size-3.5 text-red-500" />
  if (checks === 'PENDING' || checks === 'EXPECTED') return <CircleDot aria-label="Checks running" className="size-3.5 text-amber-500" />
  return null
}
