'use client'

/**
 * "Send my assistant", on a meeting prep's card in the main chat (roadmap #12,
 * docs/plans/agent-joins-meetings.md §5): the brief editor. It sits on the
 * card's foot beside the goal (MeetingGoalComposer's spot and style), and
 * shows only while the meeting is ahead and this server has MEETING_AGENT on.
 *
 *   closed     one quiet line: "Send my assistant".
 *   editing    the brief, four short lists, one line each: goals (the
 *              meeting's saved goal to start with), facts it may share,
 *              questions to ask, what it must not agree to; and this meeting
 *              or every occurrence. Checked as you type by the same rules the
 *              server keeps (parseBrief: at most BRIEF_MAX_ITEMS lines of
 *              BRIEF_MAX_CHARS, a goal or a question).
 *   review     the approval card the chat tool raises, word for word, from
 *              the server's own checks (POST preview: the meeting on your
 *              calendar, its dial-in, your name): Send, or Edit.
 *   sent       one line, and where to follow it (Settings › Meetings).
 *
 * Send is the person's opt-in for this meeting (or the series), as the chat
 * card's Accept is: POST /api/account/meeting-agent.
 */
import { useMemo, useState } from 'react'
import { Headphones } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useMeetingAgentOn } from '@/hooks/use-meeting-agent-on'
import { useMeetingGoal, type MeetingGoalMeeting } from '@/hooks/use-meeting-goal'
import { BRIEF_MAX_CHARS, BRIEF_MAX_ITEMS, briefIsEmpty, parseBrief, type BriefField, type MeetingBrief } from '@/lib/meeting-agent/brief'
import type { MeetingAgentCard } from '@/lib/meeting-agent/card'
import { meetingEndMs, meetingOfPrepReport } from './meeting-goal-composer'

export const MEETING_AGENT_URL = '/api/account/meeting-agent'

const FIELDS: Array<{ field: BriefField; label: string; hint: string }> = [
  { field: 'goals', label: 'Goals', hint: 'What you want out of it' },
  { field: 'may_share', label: 'Facts it may share', hint: 'Only these, nothing else about you' },
  { field: 'ask', label: 'Questions to ask', hint: 'It asks these when there is a pause' },
  { field: 'must_not_agree', label: 'Must not agree to', hint: 'Money, dates and decisions are always off limits' },
]

const SPOT = 'chat-panel-attachment w-[22rem] max-w-full self-start'
const LINE =
  'rounded-[18px] border border-border/60 bg-background px-3.5 py-2 text-left text-[14px] leading-5 text-muted-foreground dark:border-white/10'
const BOX = 'rounded-3xl border border-border/70 bg-background p-3.5 text-[14px] dark:border-white/10'

type Drafts = Record<BriefField, string>

/** One line per item: the brief as the server will read it. Pure. */
export function briefOfDrafts(drafts: Drafts): ReturnType<typeof parseBrief> {
  const lines = (text: string) => text.split('\n')
  return parseBrief({ goals: lines(drafts.goals), may_share: lines(drafts.may_share), ask: lines(drafts.ask), must_not_agree: lines(drafts.must_not_agree) })
}

/** What's wrong with a draft, in plain words, or null when it can be reviewed. Pure. */
export function briefProblem(parsed: ReturnType<typeof parseBrief>): string | null {
  if (!parsed.ok) {
    const label = FIELDS.find((f) => f.field === parsed.field)?.label ?? 'The brief'
    if (parsed.reason === 'too_many') return `${label}: at most ${BRIEF_MAX_ITEMS} lines.`
    if (parsed.reason === 'too_long') return `${label}: each line at most ${BRIEF_MAX_CHARS} characters.`
    return `${label} can't be used as it is.`
  }
  return briefIsEmpty(parsed.brief) ? 'Give it at least one goal or one question to ask.' : null
}

/** On a prep report's card: "Send my assistant" (nothing for any other message, a past meeting, or with the setting off). */
export function MeetingAssistantBrief({ metadata }: { metadata?: unknown }) {
  const ref = useMemo(() => meetingOfPrepReport(metadata), [metadata])
  const on = useMeetingAgentOn()
  if (!ref || !on || Date.now() >= meetingEndMs(ref)) return null
  return <BriefEditor calendarEventId={ref.calendarEventId} startsAt={ref.startIso} captureId={ref.captureId} />
}

type Stage = { at: 'closed' } | { at: 'editing'; error: string | null } | { at: 'review'; card: MeetingAgentCard; brief: MeetingBrief } | { at: 'sent' }

function BriefEditor({ calendarEventId, startsAt, captureId }: { calendarEventId: string; startsAt: string; captureId: string | null }) {
  const meeting = useMemo<MeetingGoalMeeting>(() => ({ calendarEventId, startsAt, captureId }), [calendarEventId, startsAt, captureId])
  const { goal } = useMeetingGoal(meeting, true)
  const [stage, setStage] = useState<Stage>({ at: 'closed' })
  const [drafts, setDrafts] = useState<Drafts>({ goals: '', may_share: '', ask: '', must_not_agree: '' })
  const [everyOccurrence, setEveryOccurrence] = useState(false)
  const [busy, setBusy] = useState(false)
  const parsed = briefOfDrafts(drafts)
  const problem = briefProblem(parsed)

  const post = async (preview: boolean, brief: MeetingBrief) => {
    const res = await fetch(MEETING_AGENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendar_event_id: calendarEventId, starts_at: startsAt, brief, every_occurrence: everyOccurrence, ...(preview ? { preview: true } : {}) }),
    })
    const body = (await res.json().catch(() => null)) as { card?: MeetingAgentCard; error?: string } | null
    return { ok: res.ok, body }
  }

  if (stage.at === 'closed') {
    return (
      <button
        type="button"
        data-meeting-assistant="open"
        className={cn(SPOT, LINE, 'w-auto transition-colors hover:text-foreground')}
        onClick={() => {
          setDrafts((d) => (d.goals || !goal ? d : { ...d, goals: goal }))
          setStage({ at: 'editing', error: null })
        }}
      >
        <Headphones aria-hidden className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        Send my assistant
      </button>
    )
  }

  if (stage.at === 'sent') {
    return (
      <p data-meeting-assistant="sent" className={cn(SPOT, LINE, 'w-auto')}>
        <Headphones aria-hidden className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        Your assistant will attend{everyOccurrence ? ' every occurrence' : ''}. Follow it in Settings › Meetings.
      </p>
    )
  }

  if (stage.at === 'review') {
    return (
      <div data-meeting-assistant="review" className={cn(SPOT, BOX)}>
        <p className="font-medium">{stage.card.title}</p>
        <p className="mt-1 whitespace-pre-line text-[13px] leading-5 text-muted-foreground">{stage.card.why}</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStage({ at: 'editing', error: null })}>
            Edit
          </Button>
          <Button
            size="sm"
            disabled={busy}
            data-meeting-assistant-send=""
            onClick={async () => {
              setBusy(true)
              try {
                const r = await post(false, stage.brief)
                setStage(r.ok ? { at: 'sent' } : { at: 'editing', error: r.body?.error ?? 'It wasn’t sent. Try again.' })
              } catch {
                setStage({ at: 'editing', error: 'It wasn’t sent. Try again.' })
              } finally {
                setBusy(false)
              }
            }}
          >
            Send
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div data-meeting-assistant="editing" className={cn(SPOT, BOX, 'space-y-3')}>
      <p className="text-[13px] leading-5 text-muted-foreground">
        It dials in, says it is your AI assistant taking notes, speaks only from this brief, and texts you when it needs you. One item per line.
      </p>
      {FIELDS.map(({ field, label, hint }) => (
        <label key={field} className="block">
          <span className="text-[13px] font-medium">{label}</span>
          <textarea
            aria-label={label}
            data-brief-field={field}
            placeholder={hint}
            rows={2}
            value={drafts[field]}
            onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
            className="mt-1 w-full resize-y rounded-xl border border-border/70 bg-background px-2.5 py-1.5 text-[14px] leading-5 outline-none focus:border-foreground/30 dark:border-white/10"
          />
        </label>
      ))}
      <fieldset className="flex gap-4 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`occurrence-${calendarEventId}`} checked={!everyOccurrence} onChange={() => setEveryOccurrence(false)} />
          This meeting
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`occurrence-${calendarEventId}`} data-every-occurrence="" checked={everyOccurrence} onChange={() => setEveryOccurrence(true)} />
          Every occurrence
        </label>
      </fieldset>
      {(stage.error || (problem && Object.values(drafts).some((d) => d.trim()))) && (
        <p data-meeting-assistant-error="" className="text-[13px] text-destructive">
          {stage.error ?? problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStage({ at: 'closed' })}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !!problem}
          data-meeting-assistant-review=""
          onClick={async () => {
            if (!parsed.ok) return
            setBusy(true)
            try {
              const r = await post(true, parsed.brief)
              setStage(r.ok && r.body?.card ? { at: 'review', card: r.body.card, brief: parsed.brief } : { at: 'editing', error: r.body?.error ?? 'It couldn’t be checked. Try again.' })
            } catch {
              setStage({ at: 'editing', error: 'It couldn’t be checked. Try again.' })
            } finally {
              setBusy(false)
            }
          }}
        >
          Review
        </Button>
      </div>
    </div>
  )
}
