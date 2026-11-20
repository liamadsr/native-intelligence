'use client'

/**
 * The rows of a local agent's transcript (contract G), drawn like the app's
 * chat (chat-message.tsx bubbles): the messages TO the local agent on the
 * right, labelled "Native Intelligence agent" or "You"; the local agent's own words on the
 * left, with the chat's own Copy and Read aloud under them on hover
 * (RowActions); its tool calls folded as the chat's are (prompt-kit/tool.tsx:
 * an icon, the step in words, its state, the input and output behind the
 * chevron), and a run of them in a row as ONE line that opens to its steps
 * (ToolRun), so a job of fifty calls reads as its words, not its calls;
 * `report`, `ask` and `finish` highlighted (the Mac body's
 * message_teammate reads "To Native Intelligence"); an edit job's branch as its card, and
 * its pull request as a link; a native question on the Mac as one line that
 * follows its answer; a message that couldn't be delivered as a red line under
 * it; and only the statuses worth a line (stopped, failed, the Mac app
 * closing), never the working ones.
 *
 * Every row is memoized on its item, and the fold keeps an unchanged item's
 * object, so a streaming delta re-renders the one row it grew. Nothing
 * animates at idle: a tool's spinner turns only while it runs.
 */
import { memo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { Check, CheckCircle, ChevronDown, CircleAlert, CircleDashed, Copy, ExternalLink, GitPullRequest, Laptop, XCircle } from 'lucide-react'
import { ReadAloudButton } from '@/app/account/(dashboard)/chat/read-aloud-button'
import { Button } from '@/components/ui/button'
import { MessageAction, MessageActions, MessageContent } from '@/components/ui/message'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { toolLine, truncate, type TranscriptItem } from '@/lib/local-agent/transcript-view'
import { BranchCard } from './branch-card'

/** Who wrote a message to the local agent. */
export function authorLabel(author: 'agent' | 'person'): string {
  return author === 'agent' ? 'Native Intelligence agent' : 'You'
}

const TOOL_TEXT_SHOWN = 4000

/** A message to the local agent: the request, or one sent since. */
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
  const label = authorLabel(author)
  return (
    <div data-local-agent-inbound={author} className="flex w-full flex-col items-end gap-1">
      <span className="px-1 text-[11px] text-muted-foreground">
        {label}
        {request ? ' · asked' : policy === 'queue' ? ' · queued' : null}
      </span>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] px-4 py-2.5 text-sm',
          author === 'person'
            ? 'bg-black text-white dark:bg-[#2f2f2f]'
            : 'border border-border/60 bg-muted/70 text-foreground dark:border-white/10',
        )}
      >
        {text}
      </div>
    </div>
  )
})

const HIGHLIGHT: Record<'report' | 'ask' | 'finish' | 'error', { label: string; className: string }> = {
  report: { label: 'Update', className: 'border-sky-500/40 bg-sky-500/5 [&_[data-label]]:text-sky-700 dark:[&_[data-label]]:text-sky-300' },
  ask: { label: 'Question', className: 'border-amber-500/40 bg-amber-500/5 [&_[data-label]]:text-amber-700 dark:[&_[data-label]]:text-amber-400' },
  finish: { label: 'Finished', className: 'border-emerald-500/40 bg-emerald-500/5 [&_[data-label]]:text-emerald-700 dark:[&_[data-label]]:text-emerald-400' },
  error: { label: 'Error', className: 'border-destructive/40 bg-destructive/5 text-destructive [&_[data-label]]:text-destructive' },
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
      <a
        data-local-agent-pull-request={item.url}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-card/50 px-3 py-2 text-xs transition-colors hover:bg-muted/60"
      >
        <GitPullRequest aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          Pull request{number ? ` #${number}` : ''} opened
          <span className="text-muted-foreground"> · {item.branch || 'its branch'}</span>
        </span>
        <ExternalLink aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
      </a>
    )
  }
  const what =
    item.pushed === true
      ? 'The branch was pushed, but no pull request was opened'
      : item.pushed === false
        ? 'The push failed'
        : "The push didn't finish"
  return (
    <p data-local-agent-pull-request="failed" className="flex w-full items-start gap-1 text-[11px] text-destructive">
      <CircleAlert aria-hidden className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">
        {what}
        {item.error ? `: ${item.error}` : '.'}
      </span>
    </p>
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
      // starting / running / waiting: the stream and the highlights already say so.
      return item.reason ? item.reason : null
  }
}

type ToolItem = Extract<TranscriptItem, { type: 'tool' }>

/** Where a call stands: running (only while the job works), done, failed, or left without a result. */
function toolState(item: ToolItem, live: boolean): 'running' | 'done' | 'failed' | 'stopped' {
  if (item.result) return item.result.ok ? 'done' : 'failed'
  return live ? 'running' : 'stopped'
}

const STATE_WORD = { running: 'Running…', done: 'Done', failed: 'Error', stopped: '' } as const

/** The chat's state icons (prompt-kit/tool.tsx): still while it runs, the label's shimmer is the motion. */
function StateIcon({ state }: { state: ReturnType<typeof toolState> }) {
  const Icon = state === 'done' ? CheckCircle : state === 'failed' ? XCircle : CircleDashed
  return <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
}

/** The fold's one line, as the chat's tool chip draws it: icon, label (shimmering while it runs), state, chevron. */
function FoldLine({
  state,
  label,
  word,
  open,
  onToggle,
  quiet = false,
}: {
  state: ReturnType<typeof toolState>
  label: string
  word: string
  open: boolean
  onToggle: () => void
  /** A step inside an opened run: lighter than the run's own line. */
  quiet?: boolean
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="group/tool flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StateIcon state={state} />
      {state === 'running' ? (
        <ShimmerText active className={cn('min-w-0 truncate text-sm', !quiet && 'font-medium')}>
          {label}
        </ShimmerText>
      ) : (
        <span className={cn('min-w-0 truncate text-sm transition-colors group-hover/tool:text-foreground', quiet ? 'text-foreground/80' : 'font-medium')}>{label}</span>
      )}
      {word && <span className="shrink-0 text-xs text-muted-foreground">{word}</span>}
      <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
    </button>
  )
}

const ToolRow = memo(function ToolRow({ item, live, quiet = false }: { item: ToolItem; live: boolean; quiet?: boolean }) {
  const [open, setOpen] = useState(false)
  const state = toolState(item, live)
  return (
    <div data-local-agent-tool={item.name} data-local-agent-tool-state={state} className="w-full min-w-0">
      <FoldLine state={state} label={toolLine(item.name, item.input)} word={STATE_WORD[state]} open={open} onToggle={() => setOpen((v) => !v)} quiet={quiet} />
      {open && (
        // `ph-no-capture`: session replay blocks the raw input and output, as the chat's chip does.
        <div className="ph-no-capture ml-6 mt-1 space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-2">
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

/** What a run of calls says on its one line: how many, and how many of them failed. */
export function toolRunWords(items: readonly ToolItem[]): { count: string; failed: string } {
  const failed = items.filter((it) => it.result && !it.result.ok).length
  return { count: `${items.length} steps`, failed: failed > 0 ? `${failed} failed` : '' }
}

/**
 * Tool calls in a row, as ONE line: the step it is on while it works
 * (shimmering), "12 steps · Done" once they have all answered. Opens to the
 * steps, each of which opens to its input and output. Its rows are drawn only
 * while it is open, so a long run costs one line.
 */
export const ToolRun = memo(
  function ToolRun({ items, live }: { items: readonly ToolItem[]; live: boolean }) {
    const [open, setOpen] = useState(false)
    const last = items[items.length - 1]
    const running = toolState(last, live) === 'running'
    const { count, failed } = toolRunWords(items)
    return (
      <div data-local-agent-tool-run={items.length} className="w-full min-w-0">
        <FoldLine
          state={running ? 'running' : 'done'}
          label={running ? toolLine(last.name, last.input) : count}
          word={running ? count : failed ? `Done · ${failed}` : 'Done'}
          open={open}
          onToggle={() => setOpen((v) => !v)}
        />
        {open && (
          <div className="ml-[7px] border-l border-border/60 pl-[15px]">
            {items.map((item) => (
              <ToolRow key={item.key} item={item} live={live} quiet />
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
const RowActions = memo(function RowActions({ id, text, className = 'mt-1' }: { id: string; text: string; className?: string }) {
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

/** One transcript item. `live`: the session is working (a tool without its result reads as running). */
export const TranscriptRow = memo(function TranscriptRow({ item, live }: { item: TranscriptItem; live: boolean }) {
  switch (item.type) {
    case 'assistant':
      return (
        // The chat's reply bubble (chat-message.tsx), without its reply and read-aloud hooks.
        <div data-local-agent-text={item.open && live ? 'streaming' : ''} className="group/la-msg flex w-full min-w-0 flex-col items-start">
          <MessageContent
            markdown
            readAloudSections={false}
            className="w-fit max-w-full rounded-[22px] border border-border/60 bg-background px-4 py-2.5 text-sm shadow-sm shadow-black/[0.03] dark:border-white/10"
          >
            {item.text}
          </MessageContent>
          {/* Once it has settled: a message still streaming has nothing whole to copy or read. */}
          {!(item.open && live) && item.text.trim() && <RowActions id={item.key} text={item.text} />}
        </div>
      )
    case 'tool':
      return <ToolRow item={item} live={live} />
    case 'report':
    case 'ask':
    case 'finish':
    case 'error': {
      const h = HIGHLIGHT[item.type]
      // The Mac body's message_teammate: a question for Native Intelligence in the cloud, who answers here.
      const label = item.type === 'ask' && item.teammate ? 'To Native Intelligence' : h.label
      return (
        <div
          data-local-agent-highlight={item.type}
          data-local-agent-teammate={item.teammate ? '' : undefined}
          className={cn('group/la-msg w-full rounded-xl border px-3 py-2', h.className)}
        >
          <div className="mb-0.5 flex min-h-6 items-center gap-2">
            <p data-label="" className="flex min-w-0 flex-1 items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
              {item.type === 'error' && <CircleAlert aria-hidden className="h-3 w-3" />}
              {label}
            </p>
            {/* On the label's own line, so the box keeps its height. */}
            {item.type !== 'error' && item.text.trim() && <RowActions id={item.key} text={item.text} className="shrink-0" />}
          </div>
          {item.type === 'error' ? (
            <p className="whitespace-pre-wrap break-words text-xs">{item.text}</p>
          ) : (
            <MessageContent markdown readAloudSections={false} className="bg-transparent p-0 text-sm text-foreground/90">
              {item.text || '…'}
            </MessageContent>
          )}

        </div>
      )
    }
    case 'status': {
      const line = statusLine(item)
      if (!line) return null
      return (
        <p data-local-agent-status={item.status} className="w-full text-center text-[11px] text-muted-foreground">
          {line}
        </p>
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
        <p
          data-local-agent-prompt={item.state}
          className={cn(
            'flex w-full items-start justify-center gap-1 text-center text-[11px]',
            item.state === 'asking' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
          )}
        >
          <Laptop aria-hidden className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{promptLine(item)}</span>
        </p>
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
