'use client'

/**
 * An edit job's result (contract C5, G): the branch the app committed the
 * local agent's changes on, in a separate worktree on the Mac. The checkout's
 * own branch is untouched, and the branch is pushed (with its pull request)
 * only after the person's yes on the Mac (teammate plan C5): the thread's
 * pull request line says when it was. So the card says where the work is and
 * copies the branch name; it offers nothing else to do.
 */
import { memo, useState } from 'react'
import { Check, Copy, GitBranch } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export interface BranchCardProps {
  name: string
  commit: string
  filesChanged: number
  insertions: number
  deletions: number
  className?: string
}

/** "3 files changed · +10 −2". */
export function branchStats(b: Pick<BranchCardProps, 'filesChanged' | 'insertions' | 'deletions'>): string {
  const files = b.filesChanged === 1 ? '1 file changed' : `${b.filesChanged} files changed`
  return `${files} · +${b.insertions} −${b.deletions}`
}

export const BranchCard = memo(function BranchCard({ name, commit, filesChanged, insertions, deletions, className }: BranchCardProps) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyTextToClipboard(name)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <div
      data-local-agent-branch={name}
      className={cn('w-full max-w-full rounded-xl border border-border/60 bg-card/50 px-3 py-2.5 text-xs', className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={name}>
          {name}
        </span>
        <button
          type="button"
          data-local-agent-branch-copy=""
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : `Copy branch ${name}`}
          title={copied ? 'Copied' : 'Copy branch name'}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-1 pl-[22px] text-muted-foreground">
        {branchStats({ filesChanged, insertions, deletions })}
        {commit ? (
          <>
            {' · '}
            <span className="font-mono" title={commit}>
              {commit.slice(0, 7)}
            </span>
          </>
        ) : null}
      </p>
      <p className="mt-0.5 pl-[22px] text-[11px] text-muted-foreground/80">
        On your Mac, in a separate copy; your checkout is as it was. It’s pushed only when you say yes on your Mac.
      </p>
    </div>
  )
})
