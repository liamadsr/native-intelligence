'use client'

/**
 * One pull request's side panel on the Reviews page
 * (docs/plans/github-reviews.md, phase 1), read live with the person's own
 * GitHub sign-in (GET /api/account/github/reviews/pull):
 *
 *   Overview  its description, its checks, the actions it is linked to that
 *             the person can see.
 *   Files     every file it changes, with a read-only diff.
 *   Merge     only when the server says nothing blocks it (open, not a
 *             draft, approved or needing no review, checks passing, GitHub
 *             calling it clean, and the person's access at least write);
 *             always confirmed first, pinned to the head commit shown.
 *   GitHub    approving and commenting stay there: "Review on GitHub".
 */
import * as React from 'react'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Markdown } from '@/components/ui/markdown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { parsePatch, type MergeMethod, type ReviewCheck, type ReviewFile, type ReviewPr } from '@/lib/github/reviews'
import { ChecksIcon, PrStateIcon } from './icons'

interface PullAnswer {
  pr?: ReviewPr
  body?: string
  checks?: ReviewCheck[]
  files?: ReviewFile[]
  mergeBlocker?: string | null
  error?: string
}

const METHOD_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' }

/** A PR description without its HTML comments (templates' hints), which the renderer would show as text. */
export function cleanBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim()
}

export function PullPanel({ summary, onClose, onMerged, onOpenAction }: { summary: ReviewPr; onClose: () => void; onMerged: () => void; onOpenAction: (id: string) => void }) {
  const [data, setData] = React.useState<PullAnswer | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'overview' | 'files'>('overview')
  const [confirming, setConfirming] = React.useState(false)
  const [method, setMethod] = React.useState<MergeMethod | null>(null)
  const [merging, setMerging] = React.useState(false)

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/account/github/reviews/pull?repo=${encodeURIComponent(summary.repo)}&number=${summary.number}`)
      const json = (await res.json().catch(() => ({}))) as PullAnswer
      if (!res.ok) {
        setError(json.error ?? 'Could not load the pull request.')
        return
      }
      setData(json)
      setMethod((m) => m ?? json.pr?.mergeMethods[0] ?? null)
    } catch {
      setError('Could not reach the server.')
    }
  }, [summary.repo, summary.number])

  React.useEffect(() => {
    void load()
  }, [load])

  const pr = data?.pr ?? summary
  const canMerge = !!data && data.mergeBlocker === null && !!method

  const merge = async () => {
    if (!data?.pr?.headSha || !method) return
    setMerging(true)
    try {
      const res = await fetch('/api/account/github/reviews/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: pr.repo, number: pr.number, method, sha: data.pr.headSha }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        toast.error(json.error ?? 'GitHub did not merge it.')
        void load()
        return
      }
      toast.success(`Merged ${pr.repo}#${pr.number}`)
      setConfirming(false)
      onMerged()
      void load()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setMerging(false)
    }
  }

  return (
    <aside data-reviews-panel={`${pr.repo}#${pr.number}`} aria-label="Pull request" className="flex w-[min(560px,55%)] shrink-0 flex-col border-l border-border">
      <header className="flex shrink-0 items-start gap-2 px-4 pb-2 pt-3">
        <PrStateIcon pr={pr} className="mt-1" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-snug text-foreground">{pr.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {pr.repo}#{pr.number}
            {pr.author ? ` · ${pr.author.login}` : ''}
            {pr.headRef && pr.baseRef ? ` · ${pr.headRef} → ${pr.baseRef}` : ''}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          data-reviews-github=""
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-foreground hover:bg-muted/60"
        >
          Review on GitHub <ExternalLink className="size-3" />
        </a>
        {data && pr.state === 'open' && (
          <button
            type="button"
            data-reviews-merge=""
            disabled={!canMerge}
            title={data.mergeBlocker ?? undefined}
            onClick={() => setConfirming(true)}
            className="inline-flex h-7 items-center rounded-lg bg-foreground px-2.5 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            Merge
          </button>
        )}
        {data?.mergeBlocker && pr.state === 'open' && <span data-reviews-merge-blocker="" className="text-xs text-muted-foreground">{data.mergeBlocker}</span>}
      </div>
      <div role="tablist" className="flex shrink-0 gap-1 border-b border-border px-4">
        {(['overview', 'files'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-reviews-tab={t}
            onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 px-2 py-1.5 text-xs', tab === t ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t === 'overview' ? 'Overview' : `Files changed${pr.changedFiles ? ` (${pr.changedFiles})` : ''}`}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <p className="py-8 text-center text-sm text-destructive">{error}</p>
        ) : !data ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : tab === 'overview' ? (
          <Overview data={data} onOpenAction={onOpenAction} />
        ) : (
          <Files files={data.files ?? []} total={pr.changedFiles} url={pr.url} />
        )}
      </div>
      <AlertDialog open={confirming} onOpenChange={(o) => !merging && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge {pr.repo}#{pr.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pr.title}” merges into {pr.baseRef ?? 'its base branch'} on GitHub, as you. This can’t be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pr.mergeMethods.length > 1 && (
            <div role="radiogroup" aria-label="Merge method" className="flex flex-col gap-1.5">
              {pr.mergeMethods.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="merge-method" value={m} checked={method === m} onChange={() => setMethod(m)} data-reviews-method={m} />
                  {METHOD_LABEL[m]}
                </label>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-reviews-merge-confirm=""
              disabled={merging || !method}
              onClick={(e) => {
                e.preventDefault()
                void merge()
              }}
            >
              {merging ? 'Merging…' : method ? METHOD_LABEL[method] : 'Merge'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}

function Overview({ data, onOpenAction }: { data: PullAnswer; onOpenAction: (id: string) => void }) {
  const body = cleanBody(data.body ?? '')
  const checks = data.checks ?? []
  const linked = data.pr?.linked ?? []
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="pb-1.5 text-xs font-medium text-muted-foreground">Description</h3>
        {body ? <div className="text-sm"><Markdown readAloudSections={false}>{body}</Markdown></div> : <p className="text-sm text-muted-foreground">No description.</p>}
      </section>
      <section>
        <h3 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
          Checks <ChecksIcon checks={data.pr?.checks ?? null} />
        </h3>
        {checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No checks on the latest commit.</p>
        ) : (
          <ul data-reviews-checks="" className="flex flex-col gap-1">
            {checks.map((c, i) => (
              <li key={`${c.name}-${i}`} className="flex items-center gap-2 text-sm">
                <ChecksIcon checks={c.outcome === 'success' ? 'SUCCESS' : c.outcome === 'failure' || c.outcome === 'error' || c.outcome === 'timed_out' || c.outcome === 'action_required' ? 'FAILURE' : c.outcome === 'pending' || c.outcome === 'queued' ? 'PENDING' : null} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.outcome.replace(/_/g, ' ')}</span>
                {c.url && /^https:\/\//.test(c.url) && (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" aria-label={`Details of ${c.name}`} className="text-muted-foreground hover:text-foreground">
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="pb-1.5 text-xs font-medium text-muted-foreground">Linked actions</h3>
        {linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not linked to an action. Name one (like ENG-42) in the branch, title or description to link it.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {linked.map((a) => (
              <li key={a.id}>
                <button type="button" data-reviews-linked={a.id} onClick={() => onOpenAction(a.id)} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-muted/50">
                  <span className="font-mono text-xs text-muted-foreground">{a.identifier}</span>
                  <span className="truncate">{a.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Files({ files, total, url }: { files: ReviewFile[]; total: number; url: string }) {
  if (files.length === 0) return <p className="text-sm text-muted-foreground">No changed files.</p>
  return (
    <div className="flex flex-col gap-3">
      {files.map((f) => (
        <FileDiff key={f.filename} file={f} />
      ))}
      {total > files.length && (
        <p className="text-xs text-muted-foreground">
          {total - files.length} more files: <a href={`${url}/files`} target="_blank" rel="noopener noreferrer" className="underline">see them on GitHub</a>.
        </p>
      )}
    </div>
  )
}

function FileDiff({ file }: { file: ReviewFile }) {
  const [open, setOpen] = React.useState(true)
  const lines = React.useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch])
  return (
    <section data-reviews-file={file.filename} className="overflow-hidden rounded-lg border border-border">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 bg-muted/40 px-2 py-1.5 text-left text-xs">
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.previousFilename && file.previousFilename !== file.filename ? `${file.previousFilename} → ` : ''}
          {file.filename}
        </span>
        <span className="tabular-nums text-green-600">+{file.additions}</span>
        <span className="tabular-nums text-red-600">−{file.deletions}</span>
      </button>
      {open &&
        (lines.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{file.status === 'removed' ? 'File removed.' : 'No diff to show (a binary or a very large file).'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11px] leading-[1.45]">
              <tbody>
                {lines.map((l, i) => (
                  <tr
                    key={i}
                    data-diff={l.kind}
                    className={cn(l.kind === 'add' && 'bg-green-500/10', l.kind === 'del' && 'bg-red-500/10', l.kind === 'hunk' && 'bg-blue-500/5 text-muted-foreground')}
                  >
                    <td className="w-10 select-none px-1 text-right text-muted-foreground/70">{l.oldNo ?? ''}</td>
                    <td className="w-10 select-none px-1 text-right text-muted-foreground/70">{l.newNo ?? ''}</td>
                    <td className="w-4 select-none text-center text-muted-foreground">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</td>
                    <td className="whitespace-pre pr-2">{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
}
