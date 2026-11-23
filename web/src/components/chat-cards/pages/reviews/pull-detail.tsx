'use client'

/**
 * One pull request, opened over the Reviews list as any record opens
 * (docs/plans/github-reviews.md, "Reviews on the app's own list"), read live
 * with the person's own GitHub sign-in (GET /api/account/github/reviews/pull):
 *
 *   Header      the shared breadcrumb (in a card, its header: "Reviews ›
 *               #12 title", with the previous and next pull request).
 *   Tabs        Description, Files changed (the read-only diff), Checks: the
 *               pills every record's detail has (action-detail-panel.tsx).
 *   Actions     Merge and Review on GitHub where a record's actions go
 *               (WindowActions). Merge only when the server says nothing
 *               blocks it, always confirmed first, pinned to the head commit
 *               shown; approving and commenting stay on GitHub.
 *   Properties  state, checks, review, repository, author, assignees, labels,
 *               linked actions and size, in the shared properties panel.
 */
import * as React from 'react'
import {
  CircleDashed,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitMerge,
  ListChecks,
  Loader2,
  Tag,
  UserRound,
  Users,
  Eye,
  Link2,
  Diff,
} from 'lucide-react'
import { toast } from 'sonner'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { DetailBreadcrumbHeader } from '@/app/account/(dashboard)/views/detail-breadcrumb-header'
import { WindowActions, WindowProperties } from '@/components/views/window-properties'
import { PreferenceActionButton, usePreferencesActions } from '@/components/views/preference-action'
import { EntityIcon } from '@/components/entities/entity-icon'
import { PropertyGroup } from '@/components/views/property-group'
import { PropertyRow, PropertyRows } from '@/components/views/property-layout'
import { ChecksIcon, PrStateIcon } from './icons'

interface PullAnswer {
  pr?: ReviewPr
  body?: string
  checks?: ReviewCheck[]
  files?: ReviewFile[]
  mergeBlocker?: string | null
  error?: string
}

type Tab = 'description' | 'files' | 'checks'

const METHOD_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' }

const REVIEW_LABEL: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }

const PILL = 'inline-flex shrink-0 items-center px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap'
const PILL_ON = 'bg-foreground text-background border-foreground font-medium'
const PILL_OFF = 'bg-transparent text-muted-foreground border-border hover:bg-muted hover:text-foreground'

/** A PR description without its HTML comments (templates' hints), which the renderer would show as text. */
export function cleanBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim()
}

/** A pull request not in the list (a notice opened it): the detail reads the rest. */
export function stubPr(key: string, title?: string): ReviewPr | null {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(key)
  if (!m) return null
  const [, repo, n] = m
  return {
    id: key, repo, number: Number(n), title: title ?? key, url: `https://github.com/${repo}/pull/${n}`, state: 'open', draft: false,
    mergeable: null, mergeState: null, reviewDecision: null, checks: null, createdAt: '', updatedAt: '', additions: 0, deletions: 0,
    changedFiles: 0, headRef: null, headSha: null, baseRef: null, author: null, labels: [], assignees: [], permission: null, mergeMethods: [], linked: [],
  }
}

function checkRollup(c: ReviewCheck): ReviewPr['checks'] {
  if (c.outcome === 'success') return 'SUCCESS'
  if (c.outcome === 'failure' || c.outcome === 'error' || c.outcome === 'timed_out' || c.outcome === 'action_required') return 'FAILURE'
  if (c.outcome === 'pending' || c.outcome === 'queued') return 'PENDING'
  return null
}

function checksText(checks: ReviewPr['checks']): string {
  if (checks === 'SUCCESS') return 'Passing'
  if (checks === 'FAILURE' || checks === 'ERROR') return 'Failing'
  if (checks === 'PENDING' || checks === 'EXPECTED') return 'Running'
  return 'No checks'
}

function stateText(pr: Pick<ReviewPr, 'state' | 'draft'>): string {
  if (pr.state === 'merged') return 'Merged'
  if (pr.state === 'closed') return 'Closed'
  return pr.draft ? 'Draft' : 'Open'
}

export function PullDetail({
  prKey,
  summary,
  fallbackTitle,
  onClose,
  onPrev,
  onNext,
  onMerged,
  onOpenAction,
}: {
  prKey: string
  summary: ReviewPr | null
  fallbackTitle?: string
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onMerged: () => void
  onOpenAction: (id: string) => void
}) {
  const start = React.useMemo(() => summary ?? stubPr(prKey, fallbackTitle), [summary, prKey, fallbackTitle])
  const [data, setData] = React.useState<PullAnswer | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<Tab>('description')
  const [confirming, setConfirming] = React.useState(false)
  const [method, setMethod] = React.useState<MergeMethod | null>(null)
  const [merging, setMerging] = React.useState(false)

  const repo = start?.repo ?? null
  const number = start?.number ?? null
  const load = React.useCallback(async () => {
    if (!repo || !number) return
    setError(null)
    try {
      const res = await fetch(`/api/account/github/reviews/pull?repo=${encodeURIComponent(repo)}&number=${number}`)
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
  }, [repo, number])

  React.useEffect(() => {
    void load()
  }, [load])

  const header = (title: string) => (
    <DetailBreadcrumbHeader viewTitle="Reviews" detailTitle={title} detailIdentifier={number ? `#${number}` : undefined} onBack={onClose} onPrev={onPrev} onNext={onNext} showNav />
  )

  if (!start) {
    return (
      <div className="flex h-full flex-col">
        {header(fallbackTitle ?? prKey)}
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Not a pull request.</p>
      </div>
    )
  }

  const pr = data?.pr ?? start
  const canMerge = !!data && data.mergeBlocker === null && !!method
  const checks = data?.checks ?? []

  const merge = async () => {
    if (!data?.pr?.headSha || !method) return
    setMerging(true)
    try {
      const res = await fetch('/api/account/github/reviews/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Pinned to the head commit shown: GitHub refuses if it moved since.
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

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'description', label: 'Description' },
    { id: 'files', label: `Files changed${pr.changedFiles ? ` ${pr.changedFiles}` : ''}` },
    { id: 'checks', label: `Checks${checks.length ? ` ${checks.length}` : ''}` },
  ]

  return (
    <div data-reviews-panel={`${pr.repo}#${pr.number}`} aria-label="Pull request" className="relative flex h-full min-h-0 flex-col">
      {header(pr.title)}
      <div data-reviews-toolbar="" className="mx-auto flex h-12 w-full max-w-[736px] shrink-0 items-center pl-2.5 pr-8">
        <div role="tablist" className="flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-reviews-tab={t.id} onClick={() => setTab(t.id)} className={cn(PILL, tab === t.id ? PILL_ON : PILL_OFF)}>
              {t.label}
            </button>
          ))}
        </div>
        <WindowActions className="ml-auto flex shrink-0 items-center gap-1">
          {data && pr.state === 'open' && (
            <PreferenceActionButton
              size="sm"
              label="Merge"
              data-reviews-merge=""
              disabled={!canMerge}
              title={data.mergeBlocker ?? undefined}
              onClick={() => setConfirming(true)}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <GitMerge className="h-3.5 w-3.5" />
              {/* Outside a card's properties the label is the button's own. */}
              <MergeLabel />
            </PreferenceActionButton>
          )}
          <PreferenceActionButton
            variant="ghost"
            size="sm"
            label="Review on GitHub"
            title="Review on GitHub"
            data-reviews-github=""
            onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
            className="h-7 w-7 p-0"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </WindowActions>
      </div>
      <div className="flex min-h-0 flex-1 justify-center">
        <ScrollArea scrollbar={false} className="h-full w-full">
          <div className="mx-auto w-full min-w-0 max-w-[736px] space-y-6 px-8 pb-28">
            <div className="space-y-1.5 pt-2">
              <h1 className="text-xl font-semibold leading-snug text-foreground">{pr.title}</h1>
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <PrStateIcon pr={pr} className="size-3.5" />
                <span>{stateText(pr)}</span>
                <span aria-hidden>·</span>
                <span>
                  {pr.repo}#{pr.number}
                </span>
                {pr.headRef && pr.baseRef && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono">
                      {pr.headRef} → {pr.baseRef}
                    </span>
                  </>
                )}
              </p>
              {data?.mergeBlocker && pr.state === 'open' && (
                <p data-reviews-merge-blocker="" className="text-xs text-muted-foreground">
                  {data.mergeBlocker}
                </p>
              )}
            </div>
            {error ? (
              <p className="py-8 text-center text-sm text-destructive">{error}</p>
            ) : !data ? (
              <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </p>
            ) : tab === 'description' ? (
              <Description body={data.body ?? ''} />
            ) : tab === 'files' ? (
              <Files files={data.files ?? []} total={pr.changedFiles} url={pr.url} />
            ) : (
              <Checks checks={checks} />
            )}
          </div>
        </ScrollArea>
      </div>
      <WindowProperties key={prKey} title={pr.title}>
        <div data-reviews-properties="" className="space-y-4 p-4">
          <PropertyGroup>
            <PropertyRows>
              <Prop icon={<PrStateIcon pr={pr} className="h-4 w-4" />} label="State">
                {stateText(pr)}
              </Prop>
              <Prop icon={<ListChecks className="h-4 w-4 text-muted-foreground" />} label="Checks">
                <span className="flex items-center gap-1.5">
                  <ChecksIcon checks={pr.checks} />
                  {checksText(pr.checks)}
                </span>
              </Prop>
              <Prop icon={<Eye className="h-4 w-4 text-muted-foreground" />} label="Review">
                {pr.reviewDecision ? (REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision) : 'No review required'}
              </Prop>
              <Prop icon={<FolderGit2 className="h-4 w-4 text-muted-foreground" />} label="Repository">
                {pr.repo}
              </Prop>
              <Prop icon={<UserRound className="h-4 w-4 text-muted-foreground" />} label="Author">
                {pr.author?.login ?? '—'}
              </Prop>
              <Prop icon={<Users className="h-4 w-4 text-muted-foreground" />} label="Assignees">
                {pr.assignees.length ? pr.assignees.map((a) => a.login).join(', ') : 'No one'}
              </Prop>
              <Prop icon={<Tag className="h-4 w-4 text-muted-foreground" />} label="Labels">
                {pr.labels.length ? (
                  <span className="flex min-w-0 flex-wrap gap-1">
                    {pr.labels.map((l) => (
                      <span key={l.name} className="rounded-full border border-border px-1.5 py-px text-xs">
                        {l.name}
                      </span>
                    ))}
                  </span>
                ) : (
                  'None'
                )}
              </Prop>
              <Prop icon={<Diff className="h-4 w-4 text-muted-foreground" />} label="Size">
                <span className="tabular-nums">
                  <span className="text-green-600">+{pr.additions}</span> <span className="text-red-600">−{pr.deletions}</span>
                  <span className="text-muted-foreground"> · {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}</span>
                </span>
              </Prop>
              {pr.headRef && (
                <Prop icon={<GitBranch className="h-4 w-4 text-muted-foreground" />} label="Branch">
                  <span className="truncate font-mono text-xs">{pr.headRef}</span>
                </Prop>
              )}
            </PropertyRows>
          </PropertyGroup>
          <PropertyGroup title="Linked actions">
            {pr.linked.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                <Link2 className="mr-1 inline h-3.5 w-3.5" />
                Name an action (like ENG-42) in the branch, title or description to link it.
              </p>
            ) : (
              <div className="flex flex-col">
                {pr.linked.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    data-reviews-linked={a.id}
                    onClick={() => onOpenAction(a.id)}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted/50"
                  >
                    <EntityIcon kind="action" size="md" />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{a.identifier}</span>
                    <span className="min-w-0 truncate">{a.title}</span>
                  </button>
                ))}
              </div>
            )}
          </PropertyGroup>
        </div>
      </WindowProperties>
      <AlertDialog open={confirming} onOpenChange={(o) => !merging && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {pr.repo}#{pr.number}?
            </AlertDialogTitle>
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
    </div>
  )
}

/** "Merge" on the toolbar's own button; inside a card's properties the row carries its label. */
function MergeLabel() {
  return usePreferencesActions() ? null : <span>Merge</span>
}

/** One property row, as every detail panel's: a muted icon, then the value. */
function Prop({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <PropertyRow>
      <div data-reviews-prop={label} className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm" title={label}>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
          {icon}
        </span>
        <span className="sr-only">{label}: </span>
        <span className="min-w-0 truncate">{children}</span>
      </div>
    </PropertyRow>
  )
}

function Description({ body }: { body: string }) {
  const text = cleanBody(body)
  if (!text) return <p className="text-sm text-muted-foreground">No description.</p>
  return (
    <Markdown readAloudSections={false} className="prose prose-sm max-w-none dark:prose-invert prose-headings:mb-1 prose-headings:mt-3 prose-headings:text-sm prose-headings:font-semibold">
      {text}
    </Markdown>
  )
}

function Checks({ checks }: { checks: ReviewCheck[] }) {
  if (checks.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleDashed className="h-4 w-4" /> No checks on the latest commit.
      </p>
    )
  }
  return (
    <ul data-reviews-checks="" className="flex flex-col">
      {checks.map((c, i) => (
        <li key={`${c.name}-${i}`} className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/50">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <ChecksIcon checks={checkRollup(c)} />
          </span>
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
          {total - files.length} more {total - files.length === 1 ? 'file' : 'files'}:{' '}
          <a href={`${url}/files`} target="_blank" rel="noopener noreferrer" className="underline">
            see them on GitHub
          </a>
          .
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
