'use client'

/**
 * A local agent's panel (contract G, plan "The full build" 3, "Watch"): the
 * whole conversation between the Native Intelligence agent and the local agent working on
 * your Mac, across every turn of its session, with a box to chime in.
 *
 * Opened where a helper's run opens (a bot's page in item view: the chat
 * side, ItemConversation's `local_agent` branch; on its own in the work
 * item's panel, WorkItemDetailPanel's), from the Agents widget, the chat's
 * report chip and For you alike: every one of them opens the ledger row, and
 * the row's `source.local_agent_session_id` names the session.
 *
 *   header      the teammate, "Native Intelligence on <Mac>" (teammate plan C4),
 *               or the person's own coding agent ("Claude Code on <Mac>",
 *               migration 658) when it does the work, its
 *               folder, whether it may edit, its status, its pull request, Stop
 *   transcript  the request, then everything since (transcript-rows.tsx),
 *               scrolling with the stream while you're at the bottom. Only
 *               the newest RENDER_WINDOW items are drawn; "Show earlier"
 *               draws more, and reads an older page once all held are
 *               drawn (the session opens on its newest page)
 *   question    when it asked one: what you send answers it (the reply box
 *               IS the question card's answer: the message route resumes the
 *               turn's ledger row). A question to Native Intelligence in the cloud
 *               (message_teammate) says Native Intelligence answers it, though you may too
 *   on the Mac  while a native question is open there (a push, a folder):
 *               "Waiting for you on your Mac" (invariant 5)
 *   results     an edit job with a branch: "Conversation" and "Changes"
 *               (changes-view.tsx, read from that Mac; the branch card opens
 *               it too), and, once its turn ended with no pull request,
 *               "Open pull request", which sends the job the follow-up that
 *               asks for one (the agent writes it; the Mac still asks before
 *               anything is pushed). From any device; hidden when the job
 *               can't take a message
 *   composer    Steer / Queue, as you (local-agent-composer.tsx); an ended
 *               session says how to get a new one instead
 *
 * Data: useLocalAgentSession (a page read, then realtime on the session's
 * events and row, with a catch-up poll). Render cost stays flat: rows are
 * memoized per item and deltas land once per frame.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ExternalLink, GitPullRequest, Laptop, Loader2, MessageCircleQuestion, Square } from 'lucide-react'
import { OPEN_PULL_REQUEST_MESSAGE, offersPullRequest } from '@/lib/local-agent/changes'
import { AgentIcon } from '@/components/agents/agent-icon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isGithubPullRequestUrl } from '@/lib/local-agent/pull-request'
import { macTeammateName } from '@/lib/local-agent/teammate'
import { workerLabel } from '@/lib/environments/types'
import {
  canMessageSession,
  canStopSession,
  isPromptOpen,
  isSessionEnded,
  sessionEndedText,
  sessionStatusText,
  type TranscriptItem,
} from '@/lib/local-agent/transcript-view'
import { useLocalAgentSession } from './use-local-agent-session'
import { InboundBubble, TranscriptRow } from './transcript-rows'
import { LocalAgentComposer } from './local-agent-composer'
import { BranchCardActions } from './branch-card'
import { ChangesView } from './changes-view'
import type { PanelSession } from './session-api'

/** Within this many px of the bottom, the transcript follows the stream. */
const STICK_PX = 48
/** How many items are drawn at once, and how many more each "Show earlier" draws. */
export const RENDER_WINDOW = 300

function isWorking(status: PanelSession['status']): boolean {
  return status === 'queued' || status === 'starting' || status === 'running'
}

/** Only tools and streaming text read `live`: other rows never re-render when it flips. */
function liveFor(item: TranscriptItem, live: boolean): boolean {
  return live && (item.type === 'tool' || item.type === 'assistant')
}

export function LocalAgentHeader({
  session,
  stopping,
  onStop,
}: {
  session: PanelSession
  stopping: boolean
  onStop: () => void
}) {
  const working = isWorking(session.status)
  const ended = isSessionEnded(session.status)
  // Who does the work (migration 658): the person's own coding agent, named, or Native Intelligence on that Mac.
  const worker = session.worker ?? null
  const teammate = worker ? `${workerLabel(worker)} on ${session.deviceName || 'your Mac'}` : macTeammateName(session.deviceName)
  const prUrl = isGithubPullRequestUrl(session.prUrl) ? session.prUrl : null
  const prNumber = prUrl ? (/\/pull\/(\d+)$/.exec(prUrl)?.[1] ?? null) : null
  return (
    <div data-local-agent-header="" className="flex min-w-0 shrink-0 items-start gap-2">
      <AgentIcon className="mt-0.5 h-4 w-4" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
          <span
            data-local-agent-teammate-name=""
            {...(worker ? { 'data-local-agent-worker': worker } : {})}
            className="truncate"
            title={worker ? `${teammate}: your own ${workerLabel(worker)} account does the work` : teammate}
          >
            {teammate}
          </span>
          <span
            data-local-agent-mode={session.mode}
            className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground"
            title={session.mode === 'edit' ? 'Changes go on a new git branch in a separate copy' : 'It only reads this folder'}
          >
            {session.mode === 'edit' ? 'Edits on a branch' : 'Read only'}
          </span>
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span data-local-agent-folder="" className="flex min-w-0 shrink-0 items-center gap-1" title="The folder it works in">
            <Laptop aria-hidden className="h-3 w-3 shrink-0" />
            <span className="max-w-[10rem] truncate">{session.folderLabel || 'a folder'}</span>
            <span aria-hidden>·</span>
          </span>
          {working && <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />}
          <span data-local-agent-status-line="" className={cn('truncate', session.status === 'failed' && 'text-destructive')}>
            {stopping
              ? 'Stopping…'
              : session.queuedOnMac
                ? `Queued on ${session.deviceName || 'your Mac'} · starts when a slot frees`
                : sessionStatusText(session.status, session.lastSignal)}
            {session.status === 'failed' && session.error ? ` · ${session.error}` : null}
          </span>
        </p>
        {prUrl && (
          <a
            data-local-agent-header-pr={prUrl}
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex max-w-full items-center gap-1 text-[11px] text-foreground/80 underline-offset-2 hover:underline"
          >
            <GitPullRequest aria-hidden className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="truncate">{prNumber ? `Pull request #${prNumber}` : 'Pull request'}</span>
            <ExternalLink aria-hidden className="h-2.5 w-2.5 shrink-0" />
          </a>
        )}
      </div>
      {canStopSession(session.status) && (
        <Button
          variant="outline"
          size="sm"
          data-local-agent-stop=""
          className="h-7 shrink-0 gap-1.5 text-xs"
          onClick={onStop}
          disabled={stopping || ended}
        >
          {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3" fill="currentColor" />}
          Stop
        </Button>
      )}
    </div>
  )
}

export function LocalAgentPanel({
  sessionId,
  className,
  header = true,
  autoFocus = false,
}: {
  sessionId: string
  className?: string
  /** Draw its own header (folder, status, Stop). A host with its own Stop and title can leave it out. */
  header?: boolean
  autoFocus?: boolean
}) {
  const { session, transcript, loading, error, stopping, hasEarlier, loadingEarlier, loadEarlier, send, stop } =
    useLocalAgentSession(sessionId)
  const items = transcript.items

  // Only the newest `drawn` items render; "Show earlier" draws (and reads) more.
  const [drawn, setDrawn] = useState(RENDER_WINDOW)
  const shown = useMemo(() => (items.length > drawn ? items.slice(items.length - drawn) : items), [items, drawn])
  const hidden = items.length - shown.length

  // Follow the stream while the reader is at the bottom; keep the place when earlier items come in above.
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const anchor = anchorRef.current
    if (anchor) {
      anchorRef.current = null
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
      return
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [shown, session?.lastSignal])

  const showEarlier = useCallback(() => {
    const el = scrollRef.current
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    setDrawn((n) => n + RENDER_WINDOW)
    // All held are drawn: read the page before them.
    if (hidden === 0 && hasEarlier) void loadEarlier()
  }, [hidden, hasEarlier, loadEarlier])

  const onStop = useCallback(() => {
    void stop().then((res) => {
      if (!res.ok) toast.error(res.message)
    })
  }, [stop])

  // An edit job's results: its conversation, or its Changes (read from the Mac).
  const [view, setView] = useState<'conversation' | 'changes'>('conversation')
  const openChanges = useCallback(() => setView('changes'), [])
  // Only an edit job's branch has Changes to open (a read job's branch card offers none).
  const resultsOn = session?.mode === 'edit' && !!session.branch
  const branchActions = useMemo(() => (resultsOn ? { openChanges } : {}), [resultsOn, openChanges])
  // "Open pull request" was pressed: hidden until the job works again (its turn on the request).
  const [prAsked, setPrAsked] = useState<'sending' | 'sent' | null>(null)
  const status = session?.status
  useEffect(() => {
    if (status && status !== 'waiting') setPrAsked(null)
  }, [status])
  const sendOne = useCallback(
    async (text: string) => {
      const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      return send(text, 'queue', requestId)
    },
    [send],
  )
  const askForPullRequest = useCallback(async () => {
    setPrAsked('sending')
    const res = await sendOne(OPEN_PULL_REQUEST_MESSAGE)
    if (res.ok) setPrAsked('sent')
    else {
      setPrAsked(null)
      toast.error(res.message)
    }
  }, [sendOne])

  if (error && !session) {
    return (
      <div data-local-agent-panel={sessionId} data-local-agent-error="" className={cn('flex flex-1 items-center justify-center p-6', className)}>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (loading || !session) {
    return (
      <div data-local-agent-panel={sessionId} className={cn('flex flex-1 items-center justify-center p-6', className)}>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    )
  }

  const live = isWorking(session.status)
  const asking = session.lastSignal === 'ask' && session.status === 'waiting'
  // Its last question went to Native Intelligence in the cloud (message_teammate), who answers it here.
  const lastAsk = items.findLast((it): it is Extract<TranscriptItem, { type: 'report' | 'ask' | 'finish' | 'error' }> => it.type === 'ask')
  const askedTeammate = asking && lastAsk?.teammate === true
  // A native question is open on the Mac (C3): the person answers it there, never here.
  const lastPrompt = items.findLast((it): it is Extract<TranscriptItem, { type: 'prompt' }> => it.type === 'prompt')
  const waitingOnMac = !isSessionEnded(session.status) && !!lastPrompt && isPromptOpen(lastPrompt)
  const canMessage = canMessageSession(session.status)
  const hasResults = resultsOn
  const showChanges = hasResults && view === 'changes'
  const offerPr = canMessage && offersPullRequest(session, { promptOpen: waitingOnMac })
  // The person's own request: one they started here, or a card's Start they pressed. The chat agent's: its own.
  const requestAuthor = session.startedBy === 'person' || session.requestedByPerson === true ? 'person' : 'agent'

  return (
    <div data-local-agent-panel={sessionId} data-local-agent-session-status={session.status} className={cn('flex h-full min-h-0 flex-col gap-3', className)}>
      {header && <LocalAgentHeader session={session} stopping={stopping} onStop={onStop} />}

      {hasResults && (
        <div role="tablist" aria-label="This job" data-local-agent-views="" className="flex shrink-0 items-center gap-1 text-xs">
          {(['conversation', 'changes'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              data-local-agent-view={v}
              onClick={() => setView(v)}
              className={cn(
                'rounded-md px-2 py-1 transition-colors',
                view === v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {v === 'conversation' ? 'Conversation' : 'Changes'}
            </button>
          ))}
        </div>
      )}

      {showChanges && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
          <ChangesView
            sessionId={session.id}
            deviceId={session.deviceId}
            deviceName={session.deviceName}
            branch={session.branch}
            prUrl={session.prUrl}
            canMessage={canMessage}
            onSendNotes={sendOne}
          />
        </div>
      )}

      <BranchCardActions.Provider value={branchActions}>
      <div
        hidden={showChanges}
        ref={scrollRef}
        role="log"
        aria-label="Conversation with the local agent"
        aria-live="polite"
        aria-busy={live}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
      >
        {(hidden > 0 || hasEarlier) && (
          <button
            type="button"
            data-local-agent-earlier={hidden > 0 ? hidden : 'more'}
            onClick={showEarlier}
            disabled={loadingEarlier}
            className="self-center rounded-full px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
          >
            {loadingEarlier ? 'Loading…' : 'Show earlier'}
          </button>
        )}
        {/* The request opens the conversation: drawn once its start is. */}
        {hidden === 0 && !hasEarlier && <InboundBubble author={requestAuthor} text={session.request} request />}
        {shown.map((item) => (
          <TranscriptRow key={item.key} item={item} live={liveFor(item, live)} />
        ))}
        {session.status === 'queued' && items.length === 0 && (
          <p className="text-center text-[11px] text-muted-foreground">
            It starts when your Mac picks it up (the Native Intelligence app open and signed in).
          </p>
        )}
      </div>
      </BranchCardActions.Provider>

      {!showChanges && (offerPr || prAsked === 'sent') && (
        <div data-local-agent-pr-offer={prAsked ?? ''} className="flex shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-card/50 px-3 py-2 text-xs">
          <GitPullRequest aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {prAsked === 'sent' ? (
            <p className="min-w-0 flex-1 text-foreground/80">Asked it to open a pull request. Your Mac asks you before anything is pushed.</p>
          ) : (
            <>
              <p className="min-w-0 flex-1 text-foreground/80">The work is on its branch, with no pull request yet.</p>
              <Button
                size="sm"
                variant="outline"
                data-local-agent-open-pr=""
                className="h-7 shrink-0 gap-1.5 text-xs"
                disabled={prAsked === 'sending'}
                onClick={() => void askForPullRequest()}
              >
                {prAsked === 'sending' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitPullRequest className="h-3 w-3" />}
                Open pull request
              </Button>
            </>
          )}
        </div>
      )}

      {!showChanges && waitingOnMac && (
        <div data-local-agent-on-mac="" className="flex shrink-0 items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <Laptop aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <p className="min-w-0 flex-1">
            <span className="font-medium text-amber-700 dark:text-amber-400">Waiting for you on your Mac. </span>
            <span className="text-foreground/80">Answer the question Native Intelligence shows there.</span>
          </p>
        </div>
      )}

      {!showChanges && asking && (
        <div
          data-local-agent-asking={askedTeammate ? 'teammate' : ''}
          className="flex shrink-0 items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs"
        >
          <MessageCircleQuestion aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <p className="min-w-0 flex-1">
            <span className="font-medium text-amber-700 dark:text-amber-400">
              {askedTeammate ? 'It asked Native Intelligence, who answers here; you can too. ' : 'It’s waiting on an answer. '}
            </span>
            <span className="line-clamp-3 text-foreground/80">{session.lastSignalText || 'Reply below.'}</span>
          </p>
        </div>
      )}

      <div className="shrink-0" hidden={showChanges}>
        {canMessage ? (
          <LocalAgentComposer onSend={send} working={live} asking={asking} autoFocus={autoFocus} />
        ) : (
          <p data-local-agent-ended="" className="py-2 text-center text-xs text-muted-foreground">
            {sessionEndedText(session.status, session.error)}{' '}
            Ask the Native Intelligence agent to start a new one.
          </p>
        )}
      </div>
    </div>
  )
}
