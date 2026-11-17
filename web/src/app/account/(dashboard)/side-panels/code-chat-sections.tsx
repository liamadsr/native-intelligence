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
 *   Status       what it is doing now, in the conversation's own words, its
 *                question when it asked one, and Stop while it can be stopped.
 *   Changes      an edit job's branch and commit, and its pull request once
 *                there is one; a read-only job says so.
 *   Environment  the Mac and the folder it works in.
 *   Agent        who does the work: Native Intelligence on that Mac, or the
 *                person's own coding agent by name.
 *
 * Read from the conversation's own reader (chat/code-view-store.ts `live`):
 * no read of its own, no timer. Until that first read, blank cards.
 */
import type { ReactNode } from 'react'
import { ExternalLink, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { workerLabel } from '@/lib/environments/types'
import { isGithubPullRequestUrl } from '@/lib/local-agent/pull-request'
import { canStopSession, isSessionEnded, sessionEndedText, sessionStatusText } from '@/lib/local-agent/transcript-view'
import type { PanelSession } from '@/components/local-agent/session-api'
import { useCodeView } from '../chat/use-code-view'
import { useOptionalAgentWorkShared } from '@/components/work/agent-work-provider'
import { WorkItemDetailPanel } from '@/components/work/work-item-detail-panel'

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

export function CodeChatSections() {
  const { selected, live, error } = useCodeView()
  // The work item's panel opens records through the agents' shared source: only inside the shell.
  const inShell = useOptionalAgentWorkShared() !== null
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
