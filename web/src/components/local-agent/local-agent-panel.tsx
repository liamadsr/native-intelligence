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
 *               tool calls in a row folded into one line (drawnRows),
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
 *   results     an edit job with a branch has Changes (changes-view.tsx, read
 *               from that Mac) and, once its turn ended with no pull request,
 *               "Open pull request", which sends the job the follow-up that
 *               asks for one (the agent writes it; the Mac still asks before
 *               anything is pushed). Never for a branch with nothing on it.
 *               From any device; hidden when the job can't take a message.
 *               No tabs (Liam, 11-25: "it should just be the conversation,
 *               and changes should show on their own panel"). Home's coding
 *               chat (`onOpenChanges`) opens them in the right panel, with
 *               "Open pull request" on its Changes card, which also carries
 *               the branch card's branch, counts, commit and Copy: the
 *               transcript keeps only a quiet line where the branch was made
 *               (Liam, 11-25: the main chat "clean"). A host with no panel beside it (an
 *               action's Mac tab, a work item's panel, a bot's page) shows
 *               them here instead of the conversation, from the branch card
 *               or "View changes", "‹ Conversation" back; its pull request
 *               offer stays under the conversation
 *   composer    Steer / Queue, as you (local-agent-composer.tsx); an ended
 *               session says how to get a new one instead
 *
 * Data: useLocalAgentSession (a page read, then realtime on the session's
 * events and row, with a catch-up poll). Render cost stays flat: rows are
 * memoized per item and deltas land once per frame.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ExternalLink, FileDiff, GitPullRequest, Laptop, Loader2, MessageCircleQuestion, Square } from 'lucide-react'
import { OPEN_PULL_REQUEST_MESSAGE, offersPullRequest } from '@/lib/local-agent/changes'
import { AgentIcon } from '@/components/agents/agent-icon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isGithubPullRequestUrl } from '@/lib/local-agent/pull-request'
import { macTeammateName } from '@/lib/local-agent/teammate'
import { workerLabel } from '@/lib/environments/types'
import {
  canContinueSession,
  canMessageSession,
  CONTINUE_TEXT,
  canStopSession,
  isPromptOpen,
  isSessionEnded,
  effortLabel,
  sessionEndedText,
  sessionStatusText,
  type TranscriptItem,
} from '@/lib/local-agent/transcript-view'
import { useLocalAgentSession } from './use-local-agent-session'
import { InboundBubble, ToolRun, TranscriptRow } from './transcript-rows'
import { LocalAgentComposer } from './local-agent-composer'
import { BranchCardActions } from './branch-card'
import { ChangesView } from './changes-view'
import type { PanelSession } from './session-api'
import type { LocalAgentPolicy } from '@/lib/tauri-bridge'

/** "View changes", with its file count when the branch card said it ("View changes · 3 files"). */
export function viewChangesLabel(filesChanged: number | null): string {
  if (filesChanged === null || filesChanged <= 0) return 'View changes'
  return `View changes · ${filesChanged === 1 ? '1 file' : `${filesChanged} files`}`
}

/** Within this many px of the bottom, the transcript follows the stream. */
const STICK_PX = 48
/** How many items are drawn at once, and how many more each "Show earlier" draws. */
export const RENDER_WINDOW = 300

function isWorking(status: PanelSession['status']): boolean {
  return status === 'queued' || status === 'starting' || status === 'running'
}

type ToolItem = Extract<TranscriptItem, { type: 'tool' }>
/** What the conversation draws: an item, or tool calls in a row as one folded line. */
export type DrawnRow = { key: string; item: TranscriptItem; tools?: undefined } | { key: string; tools: ToolItem[]; item?: undefined }

/**
 * The items as rows: two or more tool calls in a row fold into one line
 * (ToolRun), keyed by its first call so it stays the same row as it grows. A
 * status with nothing to say between two calls (the fold keeps the working
 * ones, which draw nothing) does not break a run. Pure.
 */
export function drawnRows(items: readonly TranscriptItem[]): DrawnRow[] {
  const rows: DrawnRow[] = []
  let run: ToolItem[] = []
  const close = () => {
    if (run.length === 1) rows.push({ key: run[0].key, item: run[0] })
    else if (run.length > 1) rows.push({ key: `run-${run[0].key}`, tools: run })
    run = []
  }
  for (const item of items) {
    if (item.type === 'tool') {
      run.push(item)
      continue
    }
    // Drawn as nothing (transcript-rows.tsx statusLine): the calls on each side of it are one run.
    if (item.type === 'status' && !item.reason && (item.status === 'starting' || item.status === 'running' || item.status === 'waiting')) {
      if (run.length === 0) rows.push({ key: item.key, item })
      continue
    }
    close()
    rows.push({ key: item.key, item })
  }
  close()
  return rows
}

/** The agent's model and effort in a line ("gpt-5.3-codex · High"), or null when it never said. */
export function modelLine(session: Pick<PanelSession, 'model' | 'effort'>): string | null {
  if (!session.model) return null
  return session.effort ? `${session.model} · ${effortLabel(session.effort)}` : session.model
}

/** Only tools and streaming text read `live`: other rows never re-render when it flips. */
function liveFor(item: TranscriptItem, live: boolean, last: TranscriptItem | undefined): boolean {
  // Text streams only at the conversation's end: anything after it means it is whole (its Copy and Read aloud show).
  return live && (item.type === 'tool' || (item.type === 'assistant' && item === last))
}

/** Where the pull request ask stands: pressed and sending, sent (until the job works again), or not asked. */
export type PullRequestAsk = 'sending' | 'sent' | null

/**
 * "Open pull request", as one piece for every place it shows (this panel's
 * results; Home's Changes card and Changes panel, code-chat-sections.tsx):
 * pressing it sends the job the follow-up that asks for one. Hidden again
 * once the job works (its turn on the request). `send` is the job's queue.
 */
export function usePullRequestAsk(
  send: ((text: string) => Promise<{ ok: true } | { ok: false; message: string }>) | null,
  status: PanelSession['status'] | undefined,
): { asked: PullRequestAsk; ask: () => Promise<void> } {
  const [asked, setAsked] = useState<PullRequestAsk>(null)
  useEffect(() => {
    if (status && status !== 'waiting') setAsked(null)
  }, [status])
  const ask = useCallback(async () => {
    if (!send) return
    setAsked('sending')
    const res = await send(OPEN_PULL_REQUEST_MESSAGE)
    if (res.ok) setAsked('sent')
    else {
      setAsked(null)
      toast.error(res.message)
    }
  }, [send])
  return { asked, ask }
}

/** The pull request offer's row: the work is on its branch with none yet, and the button; or that it was asked. */
export function PullRequestOffer({ asked, onAsk, className, compact = false }: { asked: PullRequestAsk; onAsk: () => void; className?: string; compact?: boolean }) {
  // Compact (a card that already says there is no pull request yet): the button alone, or that it was asked.
  if (compact) {
    return asked === 'sent' ? (
      <p data-local-agent-pr-offer="sent" className={cn('text-foreground/80', className)}>
        Asked it to open a pull request. Your Mac asks you before anything is pushed.
      </p>
    ) : (
      <Button size="sm" variant="outline" data-local-agent-pr-offer={asked ?? ''} data-local-agent-open-pr="" className={cn('h-7 shrink-0 gap-1.5 text-xs', className)} disabled={asked === 'sending'} onClick={onAsk}>
        {asked === 'sending' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitPullRequest className="h-3 w-3" />}
        Open pull request
      </Button>
    )
  }
  return (
    <div data-local-agent-pr-offer={asked ?? ''} className={cn('flex shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-card/50 px-3 py-2 text-xs', className)}>
      <GitPullRequest aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      {asked === 'sent' ? (
        <p className="min-w-0 flex-1 text-foreground/80">Asked it to open a pull request. Your Mac asks you before anything is pushed.</p>
      ) : (
        <>
          <p className="min-w-0 flex-1 text-foreground/80">The work is on its branch, with no pull request yet.</p>
          <Button size="sm" variant="outline" data-local-agent-open-pr="" className="h-7 shrink-0 gap-1.5 text-xs" disabled={asked === 'sending'} onClick={onAsk}>
            {asked === 'sending' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitPullRequest className="h-3 w-3" />}
            Open pull request
          </Button>
        </>
      )}
    </div>
  )
}

/** One message to the job, queued (the notes from Changes, the pull request ask). */
export function queueOne(send: (text: string, policy: LocalAgentPolicy, requestId: string) => Promise<{ ok: true } | { ok: false; message: string }>) {
  return (text: string) => {
    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    return send(text, 'queue', requestId)
  }
}

/**
 * What the conversation knows of its results that the session row doesn't:
 * a question open on the Mac, and its branch as last committed (its file
 * count; none changed). For a host that offers them elsewhere (onLive). Pure.
 */
export function resultsOf(
  items: readonly TranscriptItem[],
  session: Pick<PanelSession, 'status' | 'branch'> | null,
): { promptOpen: boolean; noChanges: boolean; filesChanged: number | null; insertions: number | null; deletions: number | null } {
  const lastPrompt = items.findLast((it): it is Extract<TranscriptItem, { type: 'prompt' }> => it.type === 'prompt')
  const promptOpen = !!session && !isSessionEnded(session.status) && !!lastPrompt && isPromptOpen(lastPrompt)
  const lastBranch = items.findLast((it): it is Extract<TranscriptItem, { type: 'branch' }> => it.type === 'branch')
  const onBranch = !!session?.branch && !!lastBranch && lastBranch.name === session.branch
  return {
    promptOpen,
    noChanges: onBranch && lastBranch!.filesChanged === 0,
    filesChanged: onBranch ? lastBranch!.filesChanged : null,
    insertions: onBranch ? lastBranch!.insertions : null,
    deletions: onBranch ? lastBranch!.deletions : null,
  }
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
  const model = modelLine(session)
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
          {model && (
            <span data-local-agent-model="" className="flex min-w-0 shrink items-center gap-1" title="The model it runs on, and its reasoning effort">
              <span className="truncate">{model}</span>
              <span aria-hidden>·</span>
            </span>
          )}
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
  composer = true,
  onLive,
  onError,
  hideScrollbar = false,
  hideFinish = false,
  onOpenChanges,
}: {
  sessionId: string
  /**
   * The host shows the job's Changes in a panel of its own (Home's coding
   * chat: the right panel, code-chat-sections.tsx), with "Open pull request"
   * there, and its branch card's details and controls: the transcript draws
   * only a quiet line for the branch, and none of them is drawn here.
   * Absent, they show here, in place of the conversation.
   */
  onOpenChanges?: () => void
  /**
   * Leave out its `finish` summary card: for a host that shows the job's
   * record, with the same summary, beside the conversation (the Code view, with
   * its right panel's Review card on screen). Everything else draws as ever.
   */
  hideFinish?: boolean
  className?: string
  /** No scrollbar on the conversation, as the main chat has none (the Code view, which stands in its place). It scrolls the same. */
  hideScrollbar?: boolean
  /** Draw its own box to message it. A host whose own composer messages it (the Code view) leaves it out. */
  composer?: boolean
  /** What it holds, for a host that shows it elsewhere too (the Code view's right panel and composer): the session as read, its send and Stop. Null until read, and when it goes. */
  onLive?: (
    live: {
      session: PanelSession
      stopping: boolean
      send: (text: string, policy: LocalAgentPolicy, requestId: string) => Promise<{ ok: true } | { ok: false; message: string }>
      stop: () => Promise<{ ok: true } | { ok: false; message: string }>
    } & ReturnType<typeof resultsOf> | null,
  ) => void
  /** Draw its own header (folder, status, Stop). A host with its own Stop and title can leave it out. */
  header?: boolean
  autoFocus?: boolean
  /** Its first read failed and it holds nothing (the job is gone, or not this person's): for a host that shows it elsewhere too. */
  onError?: (message: string) => void
}) {
  const { session, transcript, loading, error, stopping, hasEarlier, loadingEarlier, loadEarlier, send, stop } =
    useLocalAgentSession(sessionId)
  const items = transcript.items
  const results = useMemo(() => resultsOf(items, session), [items, session])
  const { promptOpen, noChanges, filesChanged, insertions, deletions } = results
  useEffect(() => {
    if (!onLive) return
    onLive(session ? { session, stopping, send, stop, promptOpen, noChanges, filesChanged, insertions, deletions } : null)
  }, [onLive, session, stopping, send, stop, promptOpen, noChanges, filesChanged, insertions, deletions])
  useEffect(() => () => onLive?.(null), [onLive])
  useEffect(() => {
    if (error && !session) onError?.(error)
  }, [error, session, onError])

  // Only the newest `drawn` items render; "Show earlier" draws (and reads) more.
  const [drawn, setDrawn] = useState(RENDER_WINDOW)
  const shown = useMemo(() => (items.length > drawn ? items.slice(items.length - drawn) : items), [items, drawn])
  const hidden = items.length - shown.length
  const rows = useMemo(() => drawnRows(hideFinish ? shown.filter((it) => it.type !== 'finish') : shown), [shown, hideFinish])

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

  // An edit job's Changes (read from the Mac): the host's panel (onOpenChanges), else here in the conversation's place.
  const [view, setView] = useState<'conversation' | 'changes'>('conversation')
  const changesBeside = !!onOpenChanges
  const openChanges = useCallback(() => {
    if (onOpenChanges) onOpenChanges()
    else setView('changes')
  }, [onOpenChanges])
  // Only an edit job's branch has Changes to open (a read job's branch card offers none).
  const resultsOn = session?.mode === 'edit' && !!session.branch
  // Home's coding chat: the branch and its controls are on the right panel's Changes card; here, a quiet line marks the moment.
  const branchActions = useMemo(() => (changesBeside ? { quiet: true } : resultsOn ? { openChanges } : {}), [changesBeside, resultsOn, openChanges])
  const sendOne = useMemo(() => queueOne(send), [send])
  const { asked: prAsked, ask: askForPullRequest } = usePullRequestAsk(sendOne, session?.status)

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
  const waitingOnMac = promptOpen
  // An ended chat the person's next message picks up again (isContinuableEnd) takes one too.
  const canMessage = canContinueSession(session)
  const continuable = canMessage && isSessionEnded(session.status)
  // Changes here, in the conversation's place: only for a host with no panel of its own for them.
  const changesHere = resultsOn && !changesBeside
  const showChanges = changesHere && view === 'changes'
  // Its branch as last committed holds no change (the app commits at every finish, a job that changed nothing too):
  // `noChanges`. The offer is the host's while its Changes are beside the conversation, and only for a chat that
  // can take a message now (never an ended one, continuable or not).
  const offerPr = !changesBeside && canMessageSession(session.status) && offersPullRequest(session, { promptOpen: waitingOnMac, noChanges })
  // The person's own request: one they started here, or a card's Start they pressed. The chat agent's: its own.
  const requestAuthor = session.startedBy === 'person' || session.requestedByPerson === true ? 'person' : 'agent'

  return (
    <div data-local-agent-panel={sessionId} data-local-agent-session-status={session.status} className={cn('flex h-full min-h-0 flex-col gap-3', className)}>
      {header && <LocalAgentHeader session={session} stopping={stopping} onStop={onStop} />}

      {/* No tabs: a way to the Changes, or back from them (a host with its own panel for them draws neither). */}
      {changesHere && (
        <div data-local-agent-changes-bar={view} className="flex shrink-0 items-center gap-2">
          {showChanges ? (
            <>
              <button
                type="button"
                data-local-agent-back-to-conversation=""
                onClick={() => setView('conversation')}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft aria-hidden className="size-3.5" />
                Conversation
              </button>
              <h3 className="min-w-0 truncate text-sm font-medium text-foreground">Changes</h3>
            </>
          ) : (
            <button
              type="button"
              data-local-agent-open-changes=""
              onClick={openChanges}
              className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FileDiff aria-hidden className="size-3.5" />
              {viewChangesLabel(filesChanged)}
            </button>
          )}
        </div>
      )}

      {showChanges && (
        <div data-local-agent-changes="" className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', hideScrollbar ? 'scrollbar-hide' : 'pr-1')}>
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
        className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', hideScrollbar ? 'scrollbar-hide' : 'pr-1')}
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
        {rows.map((row) =>
          row.tools ? <ToolRun key={row.key} items={row.tools} live={live} /> : <TranscriptRow key={row.key} item={row.item} live={liveFor(row.item, live, shown[shown.length - 1])} />,
        )}
        {session.status === 'queued' && items.length === 0 && (
          <p className="text-center text-[11px] text-muted-foreground">
            It starts when your Mac picks it up (the Native Intelligence app open and signed in).
          </p>
        )}
      </div>
      </BranchCardActions.Provider>

      {!showChanges && !changesBeside && (offerPr || prAsked === 'sent') && <PullRequestOffer asked={prAsked} onAsk={() => void askForPullRequest()} />}

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
          <>
            {continuable && (
              <p data-local-agent-ended="continuable" className="py-2 text-center text-xs text-muted-foreground">
                {sessionEndedText(session.status, session.error)} {CONTINUE_TEXT}
              </p>
            )}
            {composer ? <LocalAgentComposer onSend={send} working={live} asking={asking} autoFocus={autoFocus} /> : null}
          </>
        ) : (
          <p data-local-agent-ended="" className="py-2 text-center text-xs text-muted-foreground">
            {sessionEndedText(session.status, session.error)}{' '}
            {/* A job the person started from the Code tab: they start the next one there too. */}
            {!composer
              ? 'Your next message starts a new chat.'
              : session.codeRequestId
                ? 'Start a new one from the Code tab in your chat.'
                : 'Ask the Native Intelligence agent to start a new one.'}
          </p>
        )}
      </div>
    </div>
  )
}
