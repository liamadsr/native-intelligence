'use client'

/**
 * The rows of a local agent's transcript (contract G), drawn like the app's
 * chat (chat-message.tsx bubbles): the messages TO the local agent on the
 * right, labelled "Dial8 agent" or "You"; the local agent's own words on the
 * left; its tool calls as one collapsed line each (open one for its input and
 * output); `report`, `ask` and `finish` highlighted (the Mac body's
 * message_teammate reads "To Dial8"); an edit job's branch as its card, and
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
import { Check, ChevronRight, CircleAlert, ExternalLink, GitPullRequest, Laptop, Loader2, X } from 'lucide-react'
import { MessageContent } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { toolLine, truncate, type TranscriptItem } from '@/lib/local-agent/transcript-view'
import { BranchCard } from './branch-card'

/** Who wrote a message to the local agent. */
export function authorLabel(author: 'agent' | 'person'): string {
  return author === 'agent' ? 'Dial8 agent' : 'You'
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

const ToolRow = memo(function ToolRow({ item, live }: { item: Extract<TranscriptItem, { type: 'tool' }>; live: boolean }) {
  const [open, setOpen] = useState(false)
  const done = !!item.result
  const failed = item.result ? !item.result.ok : false
  return (
    <div data-local-agent-tool={item.name} className="w-full text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn('h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{toolLine(item.name, item.input)}</span>
        {done ? (
          failed ? (
            <X aria-label="Refused" className="h-3 w-3 shrink-0 text-destructive" />
          ) : (
            <Check aria-label="Done" className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          )
        ) : live ? (
          <Loader2 aria-label="Running" className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : null}
      </button>
      {open && (
        <div className="ml-[18px] mt-1 space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-2">
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

/** One transcript item. `live`: the session is working (a tool without its result spins). */
export const TranscriptRow = memo(function TranscriptRow({ item, live }: { item: TranscriptItem; live: boolean }) {
  switch (item.type) {
    case 'assistant':
      return (
        // The chat's reply bubble (chat-message.tsx), without its reply and read-aloud hooks.
        <div data-local-agent-text={item.open && live ? 'streaming' : ''} className="flex w-full min-w-0 flex-col items-start">
          <MessageContent
            markdown
            readAloudSections={false}
            className="w-fit max-w-full rounded-[22px] border border-border/60 bg-background px-4 py-2.5 text-sm shadow-sm shadow-black/[0.03] dark:border-white/10"
          >
            {item.text}
          </MessageContent>
        </div>
      )
    case 'tool':
      return <ToolRow item={item} live={live} />
    case 'report':
    case 'ask':
    case 'finish':
    case 'error': {
      const h = HIGHLIGHT[item.type]
      // The Mac body's message_teammate: a question for Dial8 in the cloud, who answers here.
      const label = item.type === 'ask' && item.teammate ? 'To Dial8' : h.label
      return (
        <div
          data-local-agent-highlight={item.type}
          data-local-agent-teammate={item.teammate ? '' : undefined}
          className={cn('w-full rounded-xl border px-3 py-2', h.className)}
        >
          <p data-label="" className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
            {item.type === 'error' && <CircleAlert aria-hidden className="h-3 w-3" />}
            {label}
          </p>
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
