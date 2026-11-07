'use client'

/**
 * Guests in the owner's chat (guest access PR4), drawn with the chat's own
 * parts and no new look (src/lib/guests/chat-parts.ts has the data):
 *
 *   GuestLine           who a card is from: their initials, name and preset,
 *                       the pill For you's column puts over a bot's cards.
 *                       It opens their conversation.
 *   GuestActivityChip   one stretch of a guest's conversation, in the
 *                       teammate report's card (teammate-report-chip.tsx),
 *                       their initials in its tile. It opens the
 *                       conversation on that stretch.
 *   GuestNote           a note a guest's agent passed the owner: their line
 *                       over the words, in the agent's reply bubble.
 *   GuestRequestCard    someone asking to reach the agent (JOIN): the chat's
 *                       approval card's surface and control bar
 *                       (attention-card.tsx, card-control-bar.tsx), allowed
 *                       as Household or Colleague, or ignored, through the
 *                       People routes. Once settled, one quiet line, as a
 *                       settled ask says it (chat-ask-card.tsx SettledAsk).
 *
 * A guest's held call is the ordinary ask card with a GuestLine over it
 * (chat-ask-card.tsx ChatAskCard).
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Clock, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { CardControlBar } from '@/components/attention/card-control-bar'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { openTarget } from '@/lib/chat-cards/open-card'
import { relativeTime } from '@/lib/work/presentation'
import {
  guestActivityMeta,
  guestInitials,
  guestLine,
  type GuestActivityPartData,
  type GuestMessagePartData,
  type GuestRef,
  type GuestRequestPartData,
} from '@/lib/guests/chat-parts'
import type { GuestPresetId } from '@/lib/guests/presets'

/** Open a guest's conversation as a card in the chat, on `messageId` when given (the same card again when it's there). */
export function openGuestConversation(guest: Pick<GuestRef, 'id' | 'name'>, messageId?: string | null): void {
  openTarget({ type: 'guest', guestId: guest.id, name: guest.name, messageId: messageId ?? null }, { from: 'guest', reuse: true })
}

/** "1:15 PM", or the day before that when it isn't today. */
function shortTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** Who a card is from, over it: the pill For you's column names a bot's cards with. */
export function GuestLine({ guest }: { guest: GuestRef }) {
  return (
    <button
      type="button"
      data-guest-line={guest.id}
      onClick={() => openGuestConversation(guest, guest.message_id)}
      title={`Open ${guest.name}’s conversation`}
      className="inline-flex h-5 max-w-full items-center gap-1 self-start rounded-full bg-card/70 pl-0.5 pr-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-neutral-900/70"
    >
      <Avatar className="h-[18px] w-[18px]">
        <AvatarFallback className="bg-muted text-[9px] font-medium">{guestInitials(guest.name)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{guestLine(guest)}</span>
    </button>
  )
}

/**
 * A stretch of a guest's conversation in the owner's chat: the teammate
 * report's card (half the column, the tinted frame round a white page), the
 * guest's initials where the report has its kind's icon. No notification of
 * its own: requests are what ask for attention.
 */
export function GuestActivityChip({ data }: { data: GuestActivityPartData }) {
  const { guest } = data
  return (
    <button
      type="button"
      data-guest-activity={guest.id}
      data-chat-panel="deliverable"
      onClick={() => openGuestConversation(guest, guest.message_id)}
      className="group relative w-1/2 min-w-[15rem] max-w-[calc(100%-2.25rem)] self-start rounded-[24px] border border-border/60 bg-black/[0.04] p-1.5 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10 dark:bg-white/[0.06]"
    >
      <span className="flex min-w-0 items-center gap-3 rounded-[18px] bg-background px-3 py-2.5">
        <Avatar aria-hidden className="h-10 w-10 rounded-[12px]">
          <AvatarFallback className="rounded-[12px] bg-foreground/[0.05] text-sm font-medium text-foreground/75">{guestInitials(guest.name)}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-col">
          <span data-guest-activity-summary="" className="line-clamp-2 text-[15px] font-medium leading-5 text-foreground">
            {data.summary}
          </span>
          <span data-guest-activity-meta="" className="mt-0.5 text-[12px] leading-4 text-muted-foreground">
            {guestActivityMeta(data, shortTime(data.last_at))}
          </span>
        </span>
      </span>
    </button>
  )
}

/**
 * A note a guest's agent passed the owner (message_owner): who it is from
 * (their line, which opens the conversation), then their words in the
 * agent's own reply bubble (chat-message.tsx), and "Urgent" when it pinged
 * the owner too. Plain text: a guest's words are never markdown here.
 */
export function GuestNote({ data }: { data: GuestMessagePartData }) {
  return (
    <div data-guest-message={data.guest.id} className="flex max-w-full flex-col gap-1 self-start">
      <div className="flex items-center gap-1.5">
        <GuestLine guest={data.guest} />
        {data.urgent && <span data-guest-message-urgent="" className="text-[11px] font-medium text-muted-foreground">Urgent</span>}
      </div>
      <p className="w-fit max-w-full whitespace-pre-wrap rounded-[22px] border border-border/60 bg-background px-4 py-2.5 shadow-sm shadow-black/[0.03] dark:border-white/10">
        {data.text}
      </p>
    </div>
  )
}

/** Where an access request stands now: still waiting, allowed (as what), ignored, or gone another way. */
type RequestNow = { state: 'pending' } | { state: 'allowed'; preset: string | null } | { state: 'ignored' } | { state: 'gone' }

/** What the People route says of the row now; null when it can't be read (the part's own word stands). */
async function readRequestNow(guestId: string): Promise<RequestNow | null> {
  try {
    const res = await fetch(`/api/account/agent-guests/${guestId}`, { credentials: 'include' })
    if (res.status === 404) return { state: 'gone' }
    if (!res.ok) return null
    const body = (await res.json()) as { guest?: { state?: unknown; preset?: unknown } }
    const state = body.guest?.state
    if (state === 'requested') return { state: 'pending' }
    if (state === 'active' || state === 'invited') return { state: 'allowed', preset: typeof body.guest?.preset === 'string' ? body.guest.preset : null }
    if (state === 'removed') return { state: 'ignored' }
    return null
  } catch {
    return null
  }
}

function fromPart(data: GuestRequestPartData): RequestNow {
  return data.status === 'approved' ? { state: 'allowed', preset: data.preset ?? null } : data.status === 'ignored' ? { state: 'ignored' } : { state: 'pending' }
}

const PRESET_WORD: Record<string, string> = { household: 'Household', colleague: 'Colleague' }

function settledLine(name: string, now: Exclude<RequestNow, { state: 'pending' }>): string {
  if (now.state === 'allowed') return now.preset && PRESET_WORD[now.preset] ? `${name} can now text your agent, as ${PRESET_WORD[now.preset]}.` : `${name} can now text your agent.`
  if (now.state === 'ignored') return `You ignored ${name}’s request.`
  return `${name}’s request is no longer waiting.`
}

/**
 * Someone asking to reach the agent (a JOIN text with the owner's request
 * code): the chat's approval card, with Household and Colleague for yes and
 * Ignore for no. Only the owner's click settles it, through the People routes
 * (approve with a preset, or ignore); they hear nothing until then.
 */
export function GuestRequestCard({ data }: { data: GuestRequestPartData }) {
  const [now, setNow] = useState<RequestNow>(() => fromPart(data))
  const [read, setRead] = useState(data.status !== 'pending')
  const [busy, setBusy] = useState<GuestPresetId | 'ignore' | null>(null)
  const [failed, setFailed] = useState(false)

  // Still waiting by its part: what the row says now, once (it may have been answered in People).
  useEffect(() => {
    if (data.status !== 'pending') return
    let on = true
    void readRequestNow(data.guest_id).then((n) => {
      if (!on) return
      if (n) setNow(n)
      setRead(true)
    })
    return () => {
      on = false
    }
  }, [data.guest_id, data.status])

  const settle = useCallback(
    async (verb: GuestPresetId | 'ignore') => {
      setBusy(verb)
      setFailed(false)
      try {
        const res = await fetch(`/api/account/agent-guests/${data.guest_id}/${verb === 'ignore' ? 'ignore' : 'approve'}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(verb === 'ignore' ? {} : { preset: verb }),
        })
        if (res.ok) setNow(verb === 'ignore' ? { state: 'ignored' } : { state: 'allowed', preset: verb })
        else if (res.status === 404 || res.status === 409) setNow((await readRequestNow(data.guest_id)) ?? { state: 'gone' })
        else setFailed(true)
      } catch {
        setFailed(true)
      } finally {
        setBusy(null)
      }
    },
    [data.guest_id],
  )

  const guest: GuestRef = { id: data.guest_id, name: data.guest_name, channel: 'sms' }
  if (!read) return null
  if (now.state !== 'pending') {
    const Icon = now.state === 'allowed' ? Check : now.state === 'ignored' ? X : Clock
    return (
      <div data-guest-request-settled={now.state} className="flex w-fit max-w-full items-center gap-1.5 self-start rounded-xl border border-border/60 bg-background px-3 py-2 text-[11px] text-muted-foreground dark:border-white/10">
        <Icon className="h-3 w-3 shrink-0" />
        {settledLine(data.guest_name, now)}
      </div>
    )
  }
  const age = relativeTime(data.requested_at)
  return (
    <div data-guest-request={data.guest_id} className="flex w-full max-w-[28rem] flex-col gap-1.5 self-start">
      <span className="inline-flex h-5 max-w-full items-center gap-1 self-start rounded-full bg-card/70 pl-0.5 pr-2 text-[11px] font-medium text-muted-foreground dark:bg-neutral-900/70">
        <Avatar className="h-[18px] w-[18px]">
          <AvatarFallback className="bg-muted text-[9px] font-medium">{guestInitials(guest.name)}</AvatarFallback>
        </Avatar>
        <span className="truncate">{guest.name}</span>
        <span className="shrink-0">· wants access</span>
      </span>
      <div className={cn('flex w-full min-w-0 flex-col', FLOATING_CARD_CLASS)}>
        <div className="flex min-w-0 flex-col px-3.5 pb-2 pt-3">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground/90">{data.guest_name} asked to text your agent</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {data.phone_last4 ? `From a number ending ${data.phone_last4}. ` : ''}
            Household can ask it to do things for you; Colleague can see when you’re free and leave you messages. They hear nothing until you choose.
          </p>
          {failed && <p className="mt-1 text-xs text-red-600 dark:text-red-400">That didn’t go through. Try again.</p>}
        </div>
        <CardControlBar
          busy={!!busy}
          meta={age ? <span title={new Date(data.requested_at).toLocaleString()}>{age}</span> : undefined}
          extra={
            <>
              <Button
                size="sm"
                variant="ghost"
                data-guest-request-ignore=""
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => void settle('ignore')}
                disabled={!!busy}
                title="Ignore: they hear nothing more"
              >
                {busy === 'ignore' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                Ignore
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-guest-request-allow="colleague"
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => void settle('colleague')}
                disabled={!!busy}
                title="Allow as a Colleague: when you’re free, and messages for you"
              >
                {busy === 'colleague' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Colleague
              </Button>
            </>
          }
          primary={
            <Button
              size="sm"
              data-guest-request-allow="household"
              className="h-6 gap-1 px-2.5 text-[11px]"
              onClick={() => void settle('household')}
              disabled={!!busy}
              title="Allow as Household: they can ask your agent to do things for you"
            >
              {busy === 'household' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Household
            </Button>
          }
        />
      </div>
    </div>
  )
}
