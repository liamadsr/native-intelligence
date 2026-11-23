'use client'

/**
 * A poll in the conversation (docs/plans/channels-inbox.md, phase 3;
 * migration 703): its question, each option with its count and bar, the
 * reader's own choices ticked, who chose what (unless it's anonymous), and
 * how long it has left. A click votes (one choice replaces, several toggle,
 * the same one again takes it back), shown at once and then as the server
 * counted it. Its author closes it. Live: the poll's row changes with every
 * vote (its tally), and the card reads it again when it does; RLS keeps that
 * change to people who may read the channel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BarChart3, Check, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  applyOwnVote,
  isPollClosed,
  leadingOptionIds,
  nextChoices,
  optionPercent,
  pollStatusLine,
  type TeamChatPoll,
} from '@/lib/team-chat/polls'

export function TeamChatPollCard({
  pollId,
  meId,
  nameOf,
}: {
  pollId: string
  meId: string | null
  /** A member's name, for who voted ("You" for the reader). */
  nameOf: (memberId: string) => string
}) {
  const [poll, setPoll] = useState<TeamChatPoll | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(0)

  const load = useCallback(async () => {
    const res = await fetch(`/api/account/team-chat/polls/${pollId}`).catch(() => null)
    if (!res) return
    if (res.status === 404) return setMissing(true)
    if (!res.ok) return
    const json = (await res.json().catch(() => null)) as { poll?: TeamChatPoll } | null
    // A vote on its way: its answer is the truth, not a read that raced it.
    if (json?.poll && pending.current === 0) setPoll(json.poll)
  }, [pollId])

  useEffect(() => {
    void load()
  }, [load])

  // Live: the poll's row changes with each vote and on close.
  useEffect(() => {
    const supabase = createClient()
    const instance = Math.random().toString(36).slice(2, 10)
    let timer: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel(`team-chat-poll:${pollId}:${instance}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'team_chat_poll', filter: `id=eq.${pollId}` }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void load(), 250)
      })
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [pollId, load])

  const vote = async (optionId: string) => {
    if (!poll || busy || isPollClosed(poll)) return
    const choices = nextChoices(poll, poll.mine, optionId)
    const before = poll
    setPoll(applyOwnVote(poll, choices, meId))
    pending.current += 1
    const res = await fetch(`/api/account/team-chat/polls/${pollId}/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option_ids: choices }),
    }).catch(() => null)
    pending.current -= 1
    const json = (await res?.json().catch(() => null)) as { poll?: TeamChatPoll; error?: string } | null
    if (!res?.ok) {
      setPoll(before)
      toast.error(json?.error ?? 'Your vote did not go through')
      void load()
      return
    }
    if (json?.poll && pending.current === 0) setPoll(json.poll)
  }

  const close = async () => {
    if (!poll || busy) return
    setBusy(true)
    const res = await fetch(`/api/account/team-chat/polls/${pollId}/close`, { method: 'POST' }).catch(() => null)
    setBusy(false)
    const json = (await res?.json().catch(() => null)) as { poll?: TeamChatPoll; error?: string } | null
    if (!res?.ok) return void toast.error(json?.error ?? 'The poll could not be closed')
    if (json?.poll) setPoll(json.poll)
  }

  if (missing) {
    return <p className="mt-1 text-sm text-muted-foreground" data-team-chat-poll-missing="">This poll is gone.</p>
  }
  if (!poll) {
    return <div className="mt-1 h-24 w-full max-w-md animate-pulse rounded-2xl bg-muted/60" data-team-chat-poll-loading="" />
  }
  const closed = isPollClosed(poll)
  const leaders = closed ? new Set(leadingOptionIds(poll)) : new Set<string>()
  return (
    <div className="mt-1 w-full max-w-md rounded-2xl bg-foreground/[0.04] p-3" data-team-chat-poll={poll.id} data-closed={closed ? '' : undefined}>
      <div className="mb-2 flex items-start gap-2">
        <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-[15px] font-semibold text-foreground" data-poll-question="">
          {poll.question}
        </p>
        {closed && <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Closed" />}
      </div>
      <ul className="flex flex-col gap-1.5" role={poll.multiple ? 'group' : 'radiogroup'} aria-label={poll.question}>
        {[...poll.options]
          .sort((a, b) => a.position - b.position)
          .map((o) => {
            const mine = poll.mine.includes(o.id)
            const pct = optionPercent(o, poll.voters)
            const who = poll.anonymous ? '' : o.voter_ids.map((id) => (id === meId ? 'You' : nameOf(id))).join(', ')
            return (
              <li key={o.id}>
                <button
                  type="button"
                  role={poll.multiple ? 'checkbox' : 'radio'}
                  aria-checked={mine}
                  disabled={closed}
                  data-poll-option={o.id}
                  data-mine={mine ? '' : undefined}
                  onClick={() => void vote(o.id)}
                  title={who || undefined}
                  className={cn(
                    'relative flex w-full items-center gap-2 overflow-hidden rounded-xl px-3 py-2 text-left text-sm',
                    closed ? 'cursor-default' : 'hover:bg-foreground/[0.04]',
                    mine ? 'ring-1 ring-primary/60' : 'ring-1 ring-foreground/[0.08]',
                  )}
                >
                  <span aria-hidden className={cn('absolute inset-y-0 left-0 rounded-xl', leaders.has(o.id) ? 'bg-primary/20' : 'bg-foreground/[0.06]')} style={{ width: `${pct}%` }} />
                  <span className={cn('relative grid size-4 shrink-0 place-items-center border', poll.multiple ? 'rounded' : 'rounded-full', mine ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50')}>
                    {mine && <Check className="h-3 w-3" />}
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="relative shrink-0 tabular-nums text-xs text-muted-foreground" data-poll-count="">
                    {o.votes} · {pct}%
                  </span>
                </button>
              </li>
            )
          })}
      </ul>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" data-poll-status="">
          {pollStatusLine(poll)}
        </span>
        {!closed && poll.can_close && (
          <button type="button" onClick={() => void close()} disabled={busy} data-poll-close="" className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-accent hover:text-foreground">
            Close poll
          </button>
        )}
      </div>
    </div>
  )
}
