'use client'

/**
 * The right panel in the Code view (Liam, 11-16: "the same way right now you
 * see your main agents context and connected tools … you see your coding
 * agents things"): the selected coding chat's details, as cards in the
 * panel's own look. The same cards for every coding agent, ours or the
 * person's own (Liam, 11-16: "treat all coding agents the same").
 *
 * One card skin for all (Liam, 11-26: the cards kept apart, "cleaned up",
 * as Claude's right panel reads): a small muted sentence-case title, rows of
 * icon and label with the value on the right, truncated, its whole text in a
 * tooltip, and one quiet button style.
 *
 *   Status       the action the job works first, when it works one (its
 *                Start; Liam, 11-20: "a two way connection where I can start
 *                an action items work from the action item then I can go to
 *                the coding view and see it's chat and go to the action item
 *                from it's properties panel": its identifier and title, a
 *                press opening it). Then what it is doing now, in the
 *                conversation's own words, a dot for its state, its question
 *                when it asked one, and Stop while it can be stopped (Liam,
 *                11-26: "the action and status could be the same card").
 *   Needs you    the job's own record, only while it needs the person (its
 *                review: Mark reviewed, Dismiss; its question), the same
 *                component its page shows (work-item-detail-panel.tsx,
 *                `needsOnly`). Its summary, steps and details are not drawn
 *                here (Liam, 11-26: "I'm not sure we need the summary and the
 *                steps, details"): the conversation says what happened. Only
 *                in the shell (its openers need the agents' shared source),
 *                once the job has its turn's record.
 *   (The model and effort are not here: they are pinned under the composer,
 *   as other apps show them (Liam, 11-25; composer-code-controls.tsx
 *   CodeModelLine), where a new chat also picks them.)
 *   Status       what it is doing now, in the conversation's own words, its
 *                question when it asked one, and Stop while it can be stopped.
 *   Changes      an edit job's branch and commit, and its pull request once
 *                there is one; a read-only job says so. "View changes" (with
 *                its file count when known) opens them in this panel
 *                (CodeChangesPanel, below), and "Open pull request" is here
 *                once its turn ended with none (Liam, 11-25: the button to
 *                open the changes is on the Changes panel, not the chat).
 *                The branch and the pull request live here; the conversation
 *                keeps only a line where each happened. Where the branch is
 *                ("on your Mac, in a separate copy…") is the info icon's
 *                tooltip by the title (Liam, 11-26).
 *   Environment  the Mac and the folder it works in.
 *   Agent        who does the work: Native Intelligence on that Mac, or the
 *                person's own coding agent by name.
 *   Copy link    last.
 *
 * Read from the conversation's own reader (chat/code-chat-live.ts `live`):
 * no read of its own, no timer. Until that first read, blank cards.
 *
 * CodeChangesPanel: the job's Changes (changes-view.tsx, everything it does:
 * the files, their diff, notes sent back to the agent), the panel's whole
 * height and wider (space-plan.ts CHANGES_PANEL_WIDTH_PX), in the details'
 * place, with "‹ Details" back (side-panel-store.ts codeChanges). Also opened
 * by the transcript's branch card (code-chat-stage.tsx).
 */
import { EntityIcon } from '@/components/entities/entity-icon'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, Bot, Check, ChevronLeft, Copy, FileDiff, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, Info, Laptop, Link2, Square, type LucideIcon } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { BRANCH_WHERE, branchStats } from '@/components/local-agent/branch-card'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { workerLabel } from '@/lib/environments/types'
import { isGithubPullRequestUrl } from '@/lib/local-agent/pull-request'
import { canContinueSession, canMessageSession, canStopSession, isSessionEnded, sessionEndedText, sessionStatusText } from '@/lib/local-agent/transcript-view'
import { offersPullRequest } from '@/lib/local-agent/changes'
import { ChangesView } from '@/components/local-agent/changes-view'
import { PullRequestOffer, queueOne, usePullRequestAsk, viewChangesLabel, type PullRequestAsk } from '@/components/local-agent/local-agent-panel'
import type { PanelSession } from '@/components/local-agent/session-api'
import { useCodeView } from '../chat/use-code-view'
import { useOptionalAgentWork, useOptionalAgentWorkShared } from '@/components/work/agent-work-provider'
import { WorkItemDetailPanel } from '@/components/work/work-item-detail-panel'
import { openTarget } from '@/lib/chat-cards/open-card'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { codingChatLink } from '../chat/coding-chat-link'
import type { CodeChatLive } from '../chat/code-chat-live'
import { closeCodeChanges, openCodeChanges } from './side-panel-store'

/** Who does the work, one way for every agent: its name, and where it runs. */
export function codeAgentName(session: Pick<PanelSession, 'worker'>): string {
  return session.worker ? workerLabel(session.worker) : 'Native Intelligence'
}

/** What it is doing now, as the conversation's header says it. */
export function codeChatStatus(session: PanelSession, stopping: boolean): string {
  if (stopping) return 'Stopping…'
  if (isSessionEnded(session.status)) return sessionEndedText(session.status, session.error)
  if (session.queuedOnMac) return `Queued on ${session.deviceName || 'your Mac'}`
  return sessionStatusText(session.status, session.lastSignal)
}

/** The one quiet button every card uses (Liam, 11-26: "buttons in one quiet style"). */
export const CARD_BUTTON_CLASS = 'h-7 gap-1.5 px-2.5 text-xs font-normal'

/**
 * A card, one skin for all (Liam, 11-26, as Claude's right panel reads: the
 * same padding and radius everywhere, a small muted sentence-case title).
 * `aside`: a small control at the title's right (the Changes card's info).
 */
function Card({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} data-code-chat-section={id} className={cn('pointer-events-auto relative shrink-0 px-3 py-2.5', FLOATING_CARD_CLASS)}>
      <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {title}
        {aside}
      </h3>
      <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">{children}</div>
    </section>
  )
}

/**
 * A key/value row: a small icon and the label on the left, the value on the
 * right, truncated, its whole text in a tooltip (`full`, or the value's own
 * words when it is plain text).
 */
function Line({ icon: Icon, label, full, children }: { icon?: LucideIcon; label: string; full?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-5 min-w-0 items-center justify-between gap-3">
      <span className="flex shrink-0 items-center gap-1.5">
        {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
        {label}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1 text-right text-foreground/90" title={full ?? (typeof children === 'string' ? children : undefined)}>
        {children}
      </span>
    </div>
  )
}

/** The action a job works, as its card names it. */
interface JobAction {
  id: string
  identifier: string | null
  title: string
}

/**
 * The action a job works (an action's Start), read once per action from its
 * own route (GET /api/account/actions/[id]): the conversation's reader polls,
 * so the read stays here, never in each poll. Null with none, until it lands,
 * or when it can't be read (gone, another workspace's).
 */
export function useJobAction(actionId: string | undefined): JobAction | null {
  const [read, setRead] = useState<{ id: string; action: JobAction | null } | null>(null)
  useEffect(() => {
    if (!actionId) return
    let current = true
    void fetch(`/api/account/actions/${encodeURIComponent(actionId)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { action?: { identifier?: unknown; title?: unknown } } | null) => {
        if (!current) return
        const a = body?.action
        setRead({
          id: actionId,
          action: a ? { id: actionId, identifier: typeof a.identifier === 'string' && a.identifier ? a.identifier : null, title: typeof a.title === 'string' ? a.title : '' } : null,
        })
      })
      .catch(() => {
        if (current) setRead({ id: actionId, action: null })
      })
    return () => {
      current = false
    }
  }, [actionId])
  return actionId && read?.id === actionId ? read.action : null
}

/**
 * The action the job works, first (Liam, 11-20: "on the side panel I want to
 * see the action item the agent is working on… a two way connection"): its
 * identifier and title, a press opening it, as any action opens.
 */
function ActionRow({ action }: { action: JobAction }) {
  return (
    <div data-code-chat-section="action">
      <button
        type="button"
        data-code-chat-action={action.id}
        onClick={() => openTarget({ type: 'action', id: action.id, title: action.title }, { from: 'code-view' })}
        title={[action.identifier, action.title].filter(Boolean).join(' · ')}
        className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px] text-foreground/90 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <EntityIcon kind="action" size="sm" />
        {action.identifier && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{action.identifier}</span>}
        <span className="min-w-0 flex-1 truncate">{action.title || 'Untitled action'}</span>
        <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </div>
  )
}

/** The pull request ask, held by the panel's code view so it outlives a swap between the details and the Changes. */
type PullRequestState = { asked: PullRequestAsk; ask: () => Promise<void> }

/** "Open pull request" is offered: an edit job's turn ended on a branch with work on it and no pull request, and it can take a message. */
export function pullRequestOffered(live: Pick<CodeChatLive, 'session' | 'promptOpen' | 'noChanges'>): boolean {
  return canMessageSession(live.session.status) && offersPullRequest(live.session, { promptOpen: live.promptOpen, noChanges: live.noChanges })
}

function usePullRequestState(live: CodeChatLive | null): PullRequestState {
  const send = live?.send ?? null
  const queue = useMemo(() => (send ? queueOne(send) : null), [send])
  return usePullRequestAsk(queue, live?.session.status)
}

/**
 * The right panel's code view (side-panels.tsx): the selected coding chat's
 * details, or its Changes while they are open, one at a time. The pull
 * request ask is held here, for both.
 */
export function CodeChatPanel({ changes }: { changes: boolean }) {
  const { live } = useCodeView()
  const pr = usePullRequestState(live)
  return changes ? <CodeChangesPanel pr={pr} /> : <CodeChatSections pr={pr} />
}

/** The pull request offer as the Changes card and panel show it: while offered, or once asked (until the job works again). */
function PullRequestSlot({ live, pr, compact = false, className }: { live: CodeChatLive; pr: PullRequestState; compact?: boolean; className?: string }) {
  if (!(pullRequestOffered(live) || pr.asked === 'sent')) return null
  return <PullRequestOffer asked={pr.asked} onAsk={() => void pr.ask()} compact={compact} className={className} />
}

/**
 * The job's Changes, in the panel's place (side-panel-store.ts codeChanges):
 * "‹ Details" back, the branch, the pull request offer, then the changes view
 * filling the panel's height and scrolling. Nothing without a coding chat
 * read, nor for one with no Changes (a read-only job, no branch yet: back to
 * the details).
 */
export function CodeChangesPanel({ pr: given }: { pr?: PullRequestState } = {}) {
  const { live } = useCodeView()
  const own = usePullRequestState(given ? null : live)
  const pr = given ?? own
  const session = live?.session
  const hasChanges = !!session && session.mode === 'edit' && !!session.branch
  // A chat read with nothing to show here: the details again (another turn may give it a branch).
  useEffect(() => {
    if (live && !hasChanges) closeCodeChanges()
  }, [live, hasChanges])
  if (!live || !session || !hasChanges) return null
  const sendNote = queueOne(live.send)
  return (
    <section
      aria-label="Changes"
      data-code-changes-panel={session.id}
      className={cn('ph-no-capture pointer-events-auto relative flex min-h-0 flex-1 flex-col overflow-hidden', FLOATING_CARD_CLASS)}
    >
      <div className="shrink-0 px-3 pb-2 pt-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            data-code-changes-back=""
            onClick={() => closeCodeChanges()}
            className="-ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
            Details
          </button>
          <h3 className="min-w-0 flex-1 truncate text-[13px] text-foreground">Changes</h3>
        </div>
        <p className="mt-0.5 truncate pl-1 font-mono text-[11px] text-muted-foreground" title={session.branch ?? undefined}>
          {session.branch}
        </p>
        <PullRequestSlot live={live} pr={pr} className="mt-1.5" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 scrollbar-hide">
        {/* Keyed by the chat: another one's diff is read afresh. */}
        <ChangesView
          key={session.id}
          sessionId={session.id}
          deviceId={session.deviceId}
          deviceName={session.deviceName}
          branch={session.branch}
          prUrl={session.prUrl}
          // Notes are the person's own message: an ended chat it picks up again (canContinueSession) takes them too.
          canMessage={canContinueSession(session)}
          onSendNotes={sendNote}
        />
      </div>
    </section>
  )
}

/** Copy the branch's name, as the transcript's branch card did. */
function CopyBranch({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      data-code-chat-branch-copy=""
      onClick={() => void copyTextToClipboard(name).then((ok) => ok && setCopied(true))}
      aria-label={copied ? 'Copied' : `Copy branch ${name}`}
      title={copied ? 'Copied' : 'Copy branch name'}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
    </button>
  )
}

export function CodeChatSections({ pr: given }: { pr?: PullRequestState } = {}) {
  const { selected, live, error } = useCodeView()
  const own = usePullRequestState(given ? null : live)
  const pr = given ?? own
  // The work item's panel opens records through the agents' shared source: only inside the shell.
  const inShell = useOptionalAgentWorkShared() !== null
  const action = useJobAction(live?.session.actionId)
  if (!selected) return null
  if (error && !live) {
    return (
      <div data-code-chat-sections="error" className="flex flex-col gap-2.5">
        <Card id="status" title="Status">
          <p className="text-foreground/90">{error}</p>
          <p>Pick another chat, or send a message to start a new one.</p>
        </Card>
      </div>
    )
  }
  if (!live) {
    return (
      <div data-code-chat-sections="loading" aria-label="Loading" className="flex flex-col gap-2.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="pointer-events-auto h-16 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  const { session, stopping, stop } = live
  const asking = session.lastSignal === 'ask' && session.status === 'waiting'
  const prUrl = isGithubPullRequestUrl(session.prUrl) ? session.prUrl : null
  const prNumber = prUrl ? (/\/pull\/(\d+)$/.exec(prUrl)?.[1] ?? null) : null
  const onStop = () => {
    void stop().then((res) => {
      if (!res.ok) toast.error(res.message)
    })
  }
  const failed = session.status === 'failed'
  return (
    <div data-code-chat-sections={session.id} className="ph-no-capture flex flex-col gap-2.5">
      {/* One card for the job's state, its action first (Liam, 11-26: "the action and status could be the same card"). */}
      <Card id="status" title="Status">
        {action && <ActionRow action={action} />}
        <p data-code-chat-status={session.status} className={cn('flex min-w-0 items-center gap-2 text-foreground/90', failed && 'text-destructive')}>
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', statusDot(session, asking))} />
          <span className="min-w-0">{codeChatStatus(session, stopping)}</span>
        </p>
        {asking && session.lastSignalText && <p className="line-clamp-4 pl-3.5">{session.lastSignalText}</p>}
        {canStopSession(session.status) && (
          <Button type="button" variant="outline" size="sm" className={cn(CARD_BUTTON_CLASS, 'mt-0.5')} disabled={stopping} onClick={onStop} data-code-chat-stop="">
            <Square className="size-2.5" fill="currentColor" />
            Stop
          </Button>
        )}
      </Card>
      {inShell && session.trackedJobId && <NeedsYouCard key={session.trackedJobId} jobId={session.trackedJobId} />}
      <Card
        id="changes"
        title="Changes"
        aside={
          session.mode === 'edit' && session.branch ? (
            <span data-code-chat-branch-where="" title={BRANCH_WHERE} aria-label={BRANCH_WHERE} className="inline-flex cursor-help text-muted-foreground/80 hover:text-foreground">
              <Info aria-hidden className="size-3" />
            </span>
          ) : null
        }
      >
        {session.mode !== 'edit' ? (
          <p>Read only: it changes nothing in this folder.</p>
        ) : session.branch ? (
          <>
            <Line icon={GitBranch} label="Branch" full={session.branch}>
              <span data-code-chat-branch="" className="min-w-0 truncate font-mono text-[11px]">
                {session.branch}
              </span>
              <CopyBranch name={session.branch} />
            </Line>
            {live.filesChanged !== null && (
              <Line icon={FileDiff} label="Changed">
                <span data-code-chat-branch-stats="" className="truncate">
                  {branchStats({ filesChanged: live.filesChanged, insertions: live.insertions ?? 0, deletions: live.deletions ?? 0 })}
                </span>
              </Line>
            )}
            {session.commitSha && (
              <Line icon={GitCommitHorizontal} label="Commit" full={session.commitSha}>
                <span data-code-chat-commit="" className="font-mono text-[11px]">
                  {session.commitSha.slice(0, 7)}
                </span>
              </Line>
            )}
            <Line icon={GitPullRequest} label="Pull request" full={prUrl ?? undefined}>
              {prUrl ? (
                <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline" data-code-chat-pr={prUrl}>
                  {prNumber ? `#${prNumber}` : 'Open'}
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              )}
            </Line>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <Button type="button" variant="outline" size="sm" className={CARD_BUTTON_CLASS} onClick={() => openCodeChanges()} data-code-chat-view-changes={live.filesChanged ?? ''}>
                <FileDiff aria-hidden className="size-3" />
                {viewChangesLabel(live.filesChanged)}
              </Button>
              <PullRequestSlot live={live} pr={pr} compact />
            </div>
          </>
        ) : (
          <p>Edits go on a new branch in a separate copy. None yet.</p>
        )}
      </Card>
      <Card id="environment" title="Environment">
        <Line icon={Laptop} label="Mac">
          <span className="truncate">{session.deviceName || 'Your Mac'}</span>
        </Line>
        <Line icon={Folder} label="Folder">
          <span className="truncate">{session.folderLabel || 'A folder'}</span>
        </Line>
      </Card>
      <Card id="agent" title="Agent">
        <Line icon={Bot} label="Works as" full={session.worker ? `Your own ${workerLabel(session.worker)} account does the work, on your Mac.` : 'Native Intelligence does the work, on your Mac.'}>
          <span className="truncate">{codeAgentName(session)}</span>
        </Line>
      </Card>
      {/* The chat's own address (docs/plans/one-home.md: `/account?code=<session id>`), for a note or a teammate of theirs who can read it. */}
      <button
        type="button"
        data-code-chat-copy-link=""
        onClick={() => {
          const link = codingChatLink(window.location.origin, session.id, getClientWorkspaceId() ?? null)
          void navigator.clipboard?.writeText(link).then(
            () => toast.success('Link copied'),
            () => toast.error('Could not copy the link'),
          )
        }}
        className="pointer-events-auto inline-flex h-7 shrink-0 items-center gap-1 self-start rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Link2 aria-hidden className="size-3.5" />
        Copy link
      </button>
    </div>
  )
}

/** The status line's dot: the one place a status colour shows. */
function statusDot(session: PanelSession, asking: boolean): string {
  if (session.status === 'failed') return 'bg-destructive'
  if (asking) return 'bg-amber-500'
  if (session.status === 'running' || session.status === 'starting' || session.status === 'queued') return 'bg-emerald-500'
  return 'bg-muted-foreground/50'
}

/** Where the job's record stands, as the shared ledger rows hold it (null before they are read, or outside the shell). */
function useJobStatus(jobId: string): string | null {
  const rows = useOptionalAgentWork()?.work.rows as ReadonlyArray<{ id: string; status: string }> | null | undefined
  return rows?.find((r) => r.id === jobId)?.status ?? null
}

/**
 * The job's record, only while it needs the person (Liam, 11-26: "I'm not
 * sure we need the summary and the steps, details"): its question or its
 * review, with Mark reviewed and Dismiss, as its page shows them
 * (WorkItemDetailPanel `needsOnly`). Nothing otherwise: the conversation says
 * what happened. Its status comes from the shared rows, or the record's own
 * read; it is mounted (hidden) to read it.
 */
function NeedsYouCard({ jobId }: { jobId: string }) {
  const shared = useJobStatus(jobId)
  const [read, setRead] = useState<string | null>(null)
  const status = shared ?? read
  const needs = status === 'needs_review' || status === 'needs_input'
  const onItem = useCallback((item: { status: string } | null) => setRead(item?.status ?? null), [])
  return (
    <section
      aria-label="Needs you"
      data-code-chat-section="review"
      hidden={!needs}
      className={cn('pointer-events-auto relative flex max-h-[min(34rem,60vh)] min-h-0 shrink-0 flex-col overflow-hidden', FLOATING_CARD_CLASS)}
    >
      {/* The conversation is the middle's (`conversationBeside`). */}
      <WorkItemDetailPanel itemId={jobId} embedded shown={needs} conversationBeside needsOnly onItem={onItem} />
    </section>
  )
}
