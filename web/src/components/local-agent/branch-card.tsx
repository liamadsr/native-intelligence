'use client'

/**
 * An edit job's result (contract C5, G): the branch the app committed the
 * local agent's changes on, in a separate worktree on the Mac. The checkout's
 * own branch is untouched, and the branch is pushed (with its pull request)
 * only after the person's yes on the Mac (teammate plan C5): the thread's
 * pull request line says when it was. So the card says where the work is,
 * copies the branch name and, inside a job's panel, opens its Changes
 * (changes-view.tsx: read from that Mac, never stored).
 *
 * Quiet (Home's coding chat, whose right panel's Changes card carries all of
 * this, its controls too: Liam, 11-25, the main chat "clean"): one plain line
 * marking when the branch was made, nothing to press.
 */
import { createContext, memo, useContext, useState } from 'react'
import { Check, Copy, FileDiff, GitBranch, Info } from 'lucide-react'
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

/**
 * Where the branch is, said once, behind an info icon (Liam, 11-26: the long
 * note shortened or hidden): the branch card's and the Changes card's.
 */
export const BRANCH_WHERE = 'On your Mac, in a separate copy; your checkout is as it was. It’s pushed only when you say yes on your Mac.'

/** "3 files changed · +10 −2". */
export function branchStats(b: Pick<BranchCardProps, 'filesChanged' | 'insertions' | 'deletions'>): string {
  const files = b.filesChanged === 1 ? '1 file changed' : `${b.filesChanged} files changed`
  return `${files} · +${b.insertions} −${b.deletions}`
}

/**
 * What the job's panel lets a branch card do: open its Changes view (absent
 * outside a panel), or, `quiet`, draw only a one-line note (the host shows
 * the branch and its controls beside the conversation).
 */
export const BranchCardActions = createContext<{ openChanges?: () => void; quiet?: boolean }>({})

/** The quiet note's words: "Made branch dial8/x · 2 files changed · +10 −3". */
export function branchNote(b: Pick<BranchCardProps, 'name' | 'filesChanged' | 'insertions' | 'deletions'>): string {
  return `Made branch ${b.name} · ${branchStats(b)}`
}

export const BranchCard = memo(function BranchCard({ name, commit, filesChanged, insertions, deletions, className }: BranchCardProps) {
  const { openChanges, quiet } = useContext(BranchCardActions)
  if (quiet) {
    return (
      <p data-local-agent-branch={name} data-local-agent-branch-note="" className={cn('flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground', className)}>
        <GitBranch aria-hidden className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate" title={name}>
          {branchNote({ name, filesChanged, insertions, deletions })}
        </span>
      </p>
    )
  }
  return <BranchCardFull name={name} commit={commit} filesChanged={filesChanged} insertions={insertions} deletions={deletions} className={className} openChanges={openChanges} />
})

function BranchCardFull({ name, commit, filesChanged, insertions, deletions, className, openChanges }: BranchCardProps & { openChanges?: () => void }) {
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
        {openChanges && (
          <button
            type="button"
            data-local-agent-branch-changes=""
            onClick={openChanges}
            title="Read what changed"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FileDiff className="h-3 w-3" />
            Changes
          </button>
        )}
      </div>
      <p className="mt-1 flex items-center gap-1 pl-[22px] text-muted-foreground">
        <span>
        {branchStats({ filesChanged, insertions, deletions })}
        {commit ? (
          <>
            {' · '}
            <span className="font-mono" title={commit}>
              {commit.slice(0, 7)}
            </span>
          </>
        ) : null}
        </span>
        <span data-local-agent-branch-where="" title={BRANCH_WHERE} aria-label={BRANCH_WHERE} className="inline-flex cursor-help">
          <Info aria-hidden className="h-3 w-3" />
        </span>
      </p>
    </div>
  )
}
