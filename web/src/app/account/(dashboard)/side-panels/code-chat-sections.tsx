'use client'

/**
 * The right panel in the Code view (Liam, 11-16: "the same way right now you
 * see your main agents context and connected tools … you see your coding
 * agents things"): the selected coding chat's details, as cards in the
 * panel's own look. The same cards for every coding agent, ours or the
 * person's own (Liam, 11-16: "treat all coding agents the same").
 *
 *   Review       the job's own record, the one its page shows (the work
 *                item's panel, embedded: work-item-detail-panel.tsx): what
 *                needs the person ("Review the result": Mark reviewed,
 *                Dismiss), what happened, its steps and details. The same
 *                component, so a job reads and is reviewed the same here as
 *                on its page (Liam, 11-16: "how come I see needs review
 *                here but not on the full screen view?"). Only in the shell
 *                (its openers need the agents' shared source), and once the
 *                job has its turn's record.
 *   Model        first, at the panel's top (Liam, 11-19: "a section at the
 *                top right where you can see which model is selected and the
 *                effort level"): the model the coding agent says it runs on,
 *                and its reasoning effort. The agent's own settings on the
 *                person's own account: nothing here picks them. Not drawn
 *                until the agent has said (Native Intelligence's own agent,
 *                a job from before the desktop app told us).
 *   Status       what it is doing now, in the conversation's own words, its
 *                question when it asked one, and Stop while it can be stopped.
 *   Changes      an edit job's branch and commit, and its pull request once
 *                there is one; a read-only job says so.
 *   Environment  the Mac and the folder it works in.
 *   Agent        who does the work: Native Intelligence on that Mac, or the
 *                person's own coding agent by name.
 *   Action       first, when the job works an action (its Start): the
 *                action's identifier and title, a press opening it (Liam,
 *                11-20: "a two way connection where I can start an action
 *                items work from the action item then I can go to the coding
 *                view and see it's chat and go to the action item from it's
 *                properties panel").
 *
 * Read from the conversation's own reader (chat/code-view-store.ts `live`):
 * no read of its own, no timer. Until that first read, blank cards.
 */
import { EntityIcon } from '@/components/entities/entity-icon'
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, ExternalLink, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { workerLabel } from '@/lib/environments/types'
import { isGithubPullRequestUrl } from '@/lib/local-agent/pull-request'
import { canStopSession, effortLabel, isSessionEnded, sessionEndedText, sessionStatusText } from '@/lib/local-agent/transcript-view'
import type { PanelSession } from '@/components/local-agent/session-api'
import { useCodeView } from '../chat/use-code-view'
import { useOptionalAgentWorkShared } from '@/components/work/agent-work-provider'
import { WorkItemDetailPanel } from '@/components/work/work-item-detail-panel'
import { openTarget } from '@/lib/chat-cards/open-card'

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

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-label={title} data-code-chat-section={id} className={cn('pointer-events-auto relative shrink-0 px-3 py-2.5', FLOATING_CARD_CLASS)}>
      <h3 className="text-[13px] text-foreground">{title}</h3>
      <div className="mt-1.5 space-y-1 text-xs text-muted-foreground">{children}</div>
    </section>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate text-foreground/90">{children}</span>
    </p>
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
function ActionCard({ action }: { action: JobAction }) {
  return (
    <Card id="action" title="Action">
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
    </Card>
  )
}

export function CodeChatSections() {
  const { selected, live, error } = useCodeView()
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
  return (
    <div data-code-chat-sections={session.id} className="ph-no-capture flex flex-col gap-2.5">
      {action && <ActionCard action={action} />}
      {session.model && (
        <Card id="model" title="Model">
          <Line label="Model">
            <span data-code-chat-model="" title={session.model}>
              {session.model}
            </span>
          </Line>
          {/* A model that names no effort runs on its agent's own default. */}
          <Line label="Effort">
            <span data-code-chat-effort={session.effort ?? 'default'}>{session.effort ? effortLabel(session.effort) : 'Default'}</span>
          </Line>
        </Card>
      )}
      <Card id="status" title="Status">
        <p data-code-chat-status={session.status} className={cn('text-foreground/90', asking && 'text-amber-600 dark:text-amber-400', session.status === 'failed' && 'text-destructive')}>
          {codeChatStatus(session, stopping)}
        </p>
        {asking && session.lastSignalText && <p className="line-clamp-4">{session.lastSignalText}</p>}
        {canStopSession(session.status) && (
          <Button type="button" variant="outline" size="sm" className="mt-1 h-7 gap-1.5" disabled={stopping} onClick={onStop} data-code-chat-stop="">
            <Square className="size-3" />
            Stop
          </Button>
        )}
      </Card>
      {inShell && session.trackedJobId && (
        <section
          aria-label="Review"
          data-code-chat-section="review"
          className={cn('pointer-events-auto relative flex max-h-[min(34rem,60vh)] min-h-0 shrink-0 flex-col overflow-hidden', FLOATING_CARD_CLASS)}
        >
          {/* Keyed by its turn's record: the next turn has its own. The conversation is the middle's (`conversationBeside`). */}
          <WorkItemDetailPanel key={session.trackedJobId} itemId={session.trackedJobId} embedded shown conversationBeside />
        </section>
      )}
      <Card id="changes" title="Changes">
        {session.mode !== 'edit' ? (
          <p>Read only: it changes nothing in this folder.</p>
        ) : session.branch ? (
          <>
            <Line label="Branch">
              <span className="font-mono text-[11px]" title={session.branch}>
                {session.branch}
              </span>
            </Line>
            {session.commitSha && (
              <Line label="Commit">
                <span className="font-mono text-[11px]">{session.commitSha.slice(0, 7)}</span>
              </Line>
            )}
            {prUrl ? (
              <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground/90 underline-offset-2 hover:underline" data-code-chat-pr={prUrl}>
                Pull request{prNumber ? ` #${prNumber}` : ''}
                <ExternalLink aria-hidden className="size-3" />
              </a>
            ) : (
              <p>No pull request yet. The Changes tab in the conversation shows the files.</p>
            )}
          </>
        ) : (
          <p>Edits go on a new branch in a separate copy. None yet.</p>
        )}
      </Card>
      <Card id="environment" title="Environment">
        <Line label="Mac">{session.deviceName || 'Your Mac'}</Line>
        <Line label="Folder">{session.folderLabel || 'A folder'}</Line>
      </Card>
      <Card id="agent" title="Agent">
        <Line label="Works as">{codeAgentName(session)}</Line>
        <p>{session.worker ? `Your own ${workerLabel(session.worker)} account does the work, on your Mac.` : 'Native Intelligence does the work, on your Mac.'}</p>
      </Card>
    </div>
  )
}
