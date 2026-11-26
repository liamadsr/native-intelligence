'use client'

/**
 * The rows of a local agent's transcript (contract G), drawn as Claude Code
 * and Codex draw a coding chat (Liam, 11-26: "as close to the native Claude
 * Code and Codex experience while keeping our style"; "the chat looks all
 * funky with different colors"):
 *
 * - The local agent's own words: plain prose on the page, no bubble, with the
 *   chat's own Copy and Read aloud under them on hover (RowActions). Its
 *   `report` (an update), `ask` and `finish` read the same, a question with a
 *   small muted line saying so (the Mac body's message_teammate: "To Native
 *   Intelligence"). Only an error keeps a colour: one red line.
 * - The messages TO it: on the right, one neutral bubble; a queued one says
 *   "Queued" quietly under it, and one from the Native Intelligence agent
 *   names it there (the person's own carry no label).
 * - Its tool calls: ONE muted line per run of work that sums it up ("Ran 3
 *   commands, edited 2 files"), opening to its steps, each of which opens to
 *   its input and output (ToolRun; a lone call is its own line, ToolRow). No state
 *   icons, no "Done": a failed step says so in red.
 * - Events (the branch made, a question on the Mac and its answer, the pull
 *   request, the job stopped or failed): small muted lines with a small icon
 *   (EventLine), never a card or a centred word; the working statuses draw
 *   nothing (the right panel's Status card and the composer say them).
 *
 * Every row is memoized on its item, and the fold keeps an unchanged item's
 * object, so a streaming delta re-renders the one row it grew. Nothing
 * animates at idle: a step's shimmer runs only while it runs.
 */
import { memo, useState, type HTMLAttributes, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ArrowUpRight, Check, ChevronRight, CircleAlert, CircleSlash, Copy, GitPullRequest, Laptop, MessageCircleQuestion } from 'lucide-react'
import { ReadAloudButton } from '@/app/account/(dashboard)/chat/read-aloud-button'
import { Button } from '@/components/ui/button'
import { MessageAction, MessageActions, MessageContent } from '@/components/ui/message'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { toolLine, toolRunSummary, truncate, type TranscriptItem } from '@/lib/local-agent/transcript-view'
import { BranchCard } from './branch-card'

/** Who wrote a message to the local agent. */
export function authorLabel(author: 'agent' | 'person'): string {
  return author === 'agent' ? 'Native Intelligence agent' : 'You'
}

const TOOL_TEXT_SHOWN = 4000

/**
 * A message to the local agent: the request, or one sent since. One neutral
 * bubble on the right, as the main chat's (Liam, 11-26: no label above it):
 * under it, quietly, "Queued" for a message waiting its turn, and who sent it
 * when that was the Native Intelligence agent.
 */
export const InboundBubble = memo(function InboundBubble({
  author,
  text,
  policy,
  request = false,
}: {
  author: 'agent' | 'person'
  text: string
  policy?: 'steer' | 'queue'
  /** The session's opening request. */
  request?: boolean
}) {
  const notes = [author === 'agent' ? authorLabel(author) : null, !request && policy === 'queue' ? 'Queued' : null].filter(Boolean)
  return (
    <div data-local-agent-inbound={author} data-local-agent-request={request ? '' : undefined} className="flex w-full flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] bg-foreground/[0.06] px-4 py-2.5 text-sm leading-relaxed text-foreground dark:bg-white/[0.08]">
        {text}
      </div>
      {notes.length > 0 && (
        <span data-local-agent-inbound-note="" className="px-1 text-[11px] text-muted-foreground">
          {notes.join(' · ')}
        </span>
      )}
    </div>
  )
})

/**
 * A small muted line for something that happened (Liam, 11-26: "events are
 * small muted single lines with at most a small icon"): the branch made, a
 * question on the Mac, the pull request, the job stopped. `tone`: red for what
 * went wrong, the one colour that carries meaning here.
 */
export function EventLine({
  icon: Icon,
  tone = 'muted',
  className,
  children,
  ...rest
}: {
  icon: typeof Laptop
  tone?: 'muted' | 'error'
  className?: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLParagraphElement>, 'className' | 'children'>) {
  return (
    <p {...rest} className={cn('flex w-full min-w-0 items-start gap-1.5 text-xs leading-5', tone === 'error' ? 'text-destructive' : 'text-muted-foreground', className)}>
      <Icon aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

/** The small line over a question (an `ask`): the agent's own words are the row. */
function askLabel(teammate: boolean | undefined): string {
  return teammate ? 'To Native Intelligence' : 'Question for you'
}

/** A native question on the Mac, as the thread says where it stands. */
export function promptLine(item: Extract<TranscriptItem, { type: 'prompt' }>): string {
  const what = item.prompt === 'push' ? 'to push the branch and open a pull request' : 'to let it read one more folder'
  switch (item.state) {
    case 'asking':
      return `It asked you on your Mac ${what}.`
    case 'allowed':
      return item.prompt === 'push' ? 'You said yes on your Mac: pushing the branch.' : 'You let it read one more folder, for this job only.'
    case 'denied':
      return `You said no on your Mac (${item.prompt === 'push' ? 'nothing was pushed' : 'nothing more was opened'}).`
    case 'expired':
      return 'Nobody answered on your Mac in time, so it took that as no.'
    case 'refused':
      return `Your Mac refused ${item.prompt === 'push' ? 'the push' : 'the folder'} without asking${item.why ? `: ${item.why}` : '.'}`
  }
}

/** The pull request's line: a link once it's open, else what stopped it. */
const PullRequestRow = memo(function PullRequestRow({ item }: { item: Extract<TranscriptItem, { type: 'pull_request' }> }) {
  if (item.ok && item.url) {
    const number = /\/pull\/(\d+)$/.exec(item.url)?.[1]
    return (
      <EventLine icon={GitPullRequest}>
        <a
          data-local-agent-pull-request={item.url}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          title={item.branch ? `${item.url}\nfrom ${item.branch}` : item.url}
          className="group/pr inline-flex items-center gap-0.5 text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
        >
          Pull request{number ? ` #${number}` : ''} opened
          <ArrowUpRight aria-hidden className="h-3 w-3 shrink-0 opacity-70 group-hover/pr:opacity-100" />
        </a>
      </EventLine>
    )
  }
  const what =
    item.pushed === true
      ? 'The branch was pushed, but no pull request was opened'
      : item.pushed === false
        ? 'The push failed'
        : "The push didn't finish"
  return (
    <EventLine icon={CircleAlert} tone="error" data-local-agent-pull-request="failed">
      {what}
      {item.error ? `: ${item.error}` : '.'}
    </EventLine>
  )
})

function statusLine(item: Extract<TranscriptItem, { type: 'status' }>): string | null {
  const reason = item.reason ? `: ${item.reason}` : ''
  switch (item.status) {
    case 'interrupted':
      return `Your Mac app closed while it was working${reason}`
    case 'failed':
      return `It failed${reason}`
    case 'cancelled':
      return 'Stopped'
    case 'completed':
      return `Done${reason}`
    default:
      // starting / running / waiting ("parked" and the like): the right panel's Status card, the
      // header and the composer say where it stands (Liam, 11-26: drop the bare centred "parked").
      return null
  }
}

type ToolItem = Extract<TranscriptItem, { type: 'tool' }>

/** Where a call stands: running (only while the job works), done, failed, or left without a result. */
function toolState(item: ToolItem, live: boolean): 'running' | 'done' | 'failed' | 'stopped' {
  if (item.result) return item.result.ok ? 'done' : 'failed'
  return live ? 'running' : 'stopped'
}

/**
 * A fold's one line, muted, as Claude Code's: its words (shimmering while it
 * runs), what failed in red, and a small chevron that turns as it opens. No
 * state icon and no "Done": a settled line is simply what was done.
 */
function FoldLine({
  running,
  label,
  failed,
  open,
  onToggle,
}: {
  running: boolean
  label: string
  /** What failed, said after the label in red ("1 failed", "Failed"); empty for none. */
  failed: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="group/tool flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      {running ? (
        <ShimmerText active className="min-w-0 truncate">
          {label}
        </ShimmerText>
      ) : (
        <span data-local-agent-fold-label="" className="min-w-0 truncate">
          {label}
        </span>
      )}
      {failed && <span className="shrink-0 text-destructive">· {failed}</span>}
      <ChevronRight aria-hidden className={cn('h-3.5 w-3.5 shrink-0 opacity-60 transition-transform group-hover/tool:opacity-100 motion-reduce:transition-none', open && 'rotate-90')} />
    </button>
  )
}

/** One step inside an opened run: its line, opening to its input and output. */
const ToolRow = memo(function ToolRow({ item, live }: { item: ToolItem; live: boolean }) {
  const [open, setOpen] = useState(false)
  const state = toolState(item, live)
  return (
    <div data-local-agent-tool={item.name} data-local-agent-tool-state={state} className="w-full min-w-0">
      <FoldLine running={state === 'running'} label={toolLine(item.name, item.input)} failed={state === 'failed' ? 'Failed' : ''} open={open} onToggle={() => setOpen((v) => !v)} />
      {open && (
        // `ph-no-capture`: session replay blocks the raw input and output, as the chat's chip does.
        <div className="ph-no-capture mb-1 mt-0.5 space-y-1.5 rounded-lg bg-foreground/[0.04] p-2 dark:bg-white/[0.04]">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">
            {item.input ? truncate(item.input, TOOL_TEXT_SHOWN) : '(no input)'}
          </pre>
          {item.result && (
            <pre
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border/60 pt-1.5 font-mono text-[11px]',
                item.result.ok ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {item.result.output ? truncate(item.result.output, TOOL_TEXT_SHOWN) : '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

/** What a run of calls says on its one line: what was done ("Ran 2 commands, read 3 files"), and how many of them failed. */
export function toolRunWords(items: readonly ToolItem[]): { summary: string; failed: string } {
  const failed = items.filter((it) => it.result && !it.result.ok).length
  const summary = toolRunSummary(items)
  return { summary, failed: failed > 0 ? `${failed} failed` : '' }
}

/**
 * Tool calls in a row, as ONE muted line (Liam, 11-26: "one muted line per run
 * of work"): the step it is on while it works (shimmering), and once they have
 * all answered, what was done ("Ran 6 commands, edited 3 files"). Opens to the
 * steps, each of which opens to its input and output. Its steps are drawn only
 * while it is open, so a long run costs one line. A lone call is its own line
 * (ToolRow), in the same look.
 */
export const ToolRun = memo(
  function ToolRun({ items, live }: { items: readonly ToolItem[]; live: boolean }) {
    const [open, setOpen] = useState(false)
    const last = items[items.length - 1]
    const running = toolState(last, live) === 'running'
    const { summary, failed } = toolRunWords(items)
    return (
      <div data-local-agent-tool-run={items.length} className="w-full min-w-0">
        <FoldLine running={running} label={running ? toolLine(last.name, last.input) : summary} failed={running ? '' : failed} open={open} onToggle={() => setOpen((v) => !v)} />
        {open && (
          <div className="ml-[5px] mt-0.5 border-l border-border/60 pl-3">
            {items.map((item) => (
              <ToolRow key={item.key} item={item} live={live} />
            ))}
          </div>
        )}
      </div>
    )
  },
  // The panel groups the items anew at each change: the run re-renders only when one of its own did.
  (a, b) => a.live === b.live && a.items.length === b.items.length && a.items.every((it, i) => it === b.items[i]),
)

/**
 * The chat's own actions under one of the agent's messages (chat-message.tsx's
 * row): Copy, and Read aloud where the host reads aloud (the desktop app, in
 * the main chat's Code view: ReadAloudButton draws nothing anywhere else).
 * Shown on hover, and while this message is being read or was paused last.
 */
const RowActions = memo(function RowActions({ id, text, className = '-mb-2 mt-0' }: { id: string; text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  // What Read aloud reads: the message as the chat's own would hold it.
  const message: UIMessage = { id: `local-agent-${id}`, role: 'assistant', parts: [{ type: 'text', text }] }
  const copy = () => {
    void copyTextToClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <MessageActions
      data-local-agent-actions=""
      className={cn(
        'opacity-0 transition-opacity focus-within:opacity-100 group-hover/la-msg:opacity-100 has-[[data-read-aloud=paused]]:opacity-100 has-[[data-read-aloud=speaking]]:opacity-100 motion-reduce:transition-none',
        className,
      )}
    >
      <MessageAction tooltip={copied ? 'Copied!' : 'Copy'}>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Copy" data-local-agent-copy="" onClick={copy}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </MessageAction>
      <ReadAloudButton message={message} />
    </MessageActions>
  )
})

/** The agent's words, as plain prose on the page (Claude Code's): no bubble, border or fill. */
const PROSE_CLASS = 'max-w-full bg-transparent p-0 text-sm leading-relaxed text-foreground'

/** One transcript item. `live`: the session is working (a tool without its result reads as running). */
export const TranscriptRow = memo(function TranscriptRow({ item, live }: { item: TranscriptItem; live: boolean }) {
  switch (item.type) {
    case 'assistant':
      return (
        <div data-local-agent-text={item.open && live ? 'streaming' : ''} className="group/la-msg flex w-full min-w-0 flex-col items-start">
          <MessageContent markdown readAloudSections={false} className={PROSE_CLASS}>
            {item.text}
          </MessageContent>
          {/* Once it has settled: a message still streaming has nothing whole to copy or read. */}
          {!(item.open && live) && item.text.trim() && <RowActions id={item.key} text={item.text} />}
        </div>
      )
    case 'tool':
      // A lone call: the same quiet line as a run's, its own words.
      return <ToolRow item={item} live={live} />
    case 'report':
    case 'ask':
    case 'finish':
      // An update, a question, the turn's summary: the agent's own words, as its messages read (Liam, 11-26: no box, no caps label).
      return (
        <div
          data-local-agent-highlight={item.type}
          data-local-agent-teammate={item.teammate ? '' : undefined}
          className="group/la-msg flex w-full min-w-0 flex-col items-start"
        >
          {item.type === 'ask' && (
            <p data-label="" className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageCircleQuestion aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {askLabel(item.teammate)}
            </p>
          )}
          <MessageContent markdown readAloudSections={false} className={PROSE_CLASS}>
            {item.text || '…'}
          </MessageContent>
          {item.text.trim() && <RowActions id={item.key} text={item.text} />}
        </div>
      )
    case 'error':
      return (
        <EventLine icon={CircleAlert} tone="error" data-local-agent-highlight="error" className="whitespace-pre-wrap">
          {item.text}
        </EventLine>
      )
    case 'status': {
      const line = statusLine(item)
      if (!line) return null
      return (
        <EventLine icon={item.status === 'interrupted' ? Laptop : item.status === 'failed' ? CircleAlert : item.status === 'cancelled' ? CircleSlash : Check} tone={item.status === 'failed' ? 'error' : 'muted'} data-local-agent-status={item.status}>
          {line}
        </EventLine>
      )
    }
    case 'inbound':
      return <InboundBubble author={item.author} text={item.text} policy={item.policy} />
    case 'undelivered':
      return (
        <p
          data-local-agent-undelivered={item.messageId}
          className="flex w-full items-start justify-end gap-1 text-right text-[11px] text-destructive"
        >
          <CircleAlert aria-hidden className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">Couldn’t deliver this message: {item.reason}</span>
        </p>
      )
    case 'sent':
      return <InboundBubble author="person" text={item.text} policy={item.policy} />
    case 'prompt':
      return (
        <EventLine icon={Laptop} data-local-agent-prompt={item.state}>
          {item.state === 'asking' && <span aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />}
          {promptLine(item)}
        </EventLine>
      )
    case 'pull_request':
      return <PullRequestRow item={item} />
    case 'branch':
      return (
        <BranchCard
          name={item.name}
          commit={item.commit}
          filesChanged={item.filesChanged}
          insertions={item.insertions}
          deletions={item.deletions}
        />
      )
  }
})
