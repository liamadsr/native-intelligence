'use client'

/**
 * The goal of a prepped meeting, under its prep report's chip in the main chat
 * (Liam, 2026-10-17): "What's the goal of this call?". It rides the prep's
 * deliverable card (Liam, 10-18): over the card's foot, set in from its edge
 * (`.chat-panel-attachment`, tailwind.css), so it plainly asks about that
 * document, and it is plainly a field: the main composer's shape and hairline
 * at the chat's text size, a target before the words, wider than the card so
 * there's room to type. The page's fill, no glass blur (the thread scrolls
 * over the sky). The saved goal and a past meeting's sit in the same spot:
 *   - empty, the dictation mic where dictation is ready (the desktop); typing
 *     turns it into send. On the web there is no mic: send shows with words;
 *   - Enter saves (not mid IME composition); Escape cancels an edit (or
 *     empties a fresh draft); a save that fails opens the box again with
 *     the words that didn't save;
 *   - saved, one quiet line, "Goal: …", that opens the box again to edit;
 *     saving it empty clears the goal;
 *   - once the meeting is over (its end, else DEFAULT_MEETING_MS after its
 *     start), the saved goal read-only when this page already has it, or
 *     nothing: a finished meeting's card makes no request.
 *
 * The meeting is the report's `metadata.meeting_prep` (prep-ref.ts): its
 * calendar event and start key the goal (no calendar event, no composer), its
 * pending capture rides the save. The goal is the signed-in person's own
 * (the route fences on them), so the card shows only theirs. Read and written
 * through useMeetingGoal's shared cache; nothing runs while nothing changes
 * (one timer, to the meeting's end).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PromptInput, PromptInputActions, PromptInputTextarea } from '@/components/ui/prompt-input'
import { BubbleSendButton } from '@/components/agent-ui/send-button'
import { useDictation } from '@/hooks/use-dictation'
import { useVoiceAvailability } from '@/hooks/use-voice-availability'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { refreshMeetingGoal, useMeetingGoal, type MeetingGoalMeeting } from '@/hooks/use-meeting-goal'
import { insertDictation } from '@/lib/voice/dictation-text'
import { MEETING_PREP_KEY, parseMeetingPrepRef, type MeetingPrepRef } from '@/lib/agent-events/prep-ref'
import { DEFAULT_MEETING_MS } from '@/lib/agent-events/meeting-time'
import { MEETING_GOAL_MAX_CHARS, normalizeEventId, normalizeStartsAt } from '@/lib/meetings/meeting-goal'
import { DictationButton, reportVoiceRefusal } from './voice-controls'

export const MEETING_GOAL_PLACEHOLDER = 'What’s the goal of this call?'
/** setTimeout's ceiling is ~24.8 days; the timer re-arms in steps of a day. */
const MAX_TIMER_MS = 24 * 60 * 60_000

/** The main composer's box (ChatInput: rounded-3xl, its hairline), in the page's fill. */
const GOAL_BOX =
  'relative flex w-full items-end gap-1.5 rounded-3xl border border-border/70 bg-background p-1.5 pl-3.5 dark:border-white/10'

/**
 * Where the goal sits: on the prep card's foot (tailwind.css, data-chat-panel), whatever state it's in.
 * The spot carries the rule's shadow, so it wears the corners of what it holds (GOAL_BOX's, GOAL_LINE's):
 * a square spot round a rounded box drew faint square corners (Liam, 10-19).
 */
const GOAL_SPOT = 'chat-panel-attachment w-[22rem] max-w-full self-start'

/** A saved or past goal, in the spot: one quiet bubble. */
const GOAL_LINE =
  'rounded-[18px] border border-border/60 bg-background px-3.5 py-2 text-left text-[14px] leading-5 text-muted-foreground dark:border-white/10'

/** The prep report's meeting, when the message is one and names a calendar event. Pure. */
export function meetingOfPrepReport(metadata: unknown): (MeetingPrepRef & { calendarEventId: string }) | null {
  if (!metadata || typeof metadata !== 'object') return null
  const ref = parseMeetingPrepRef((metadata as Record<string, unknown>)[MEETING_PREP_KEY])
  return ref?.calendarEventId ? (ref as MeetingPrepRef & { calendarEventId: string }) : null
}

/** When the meeting is over: its end, else DEFAULT_MEETING_MS after its start. Pure. */
export function meetingEndMs(ref: Pick<MeetingPrepRef, 'startIso' | 'endIso'>): number {
  const start = Date.parse(ref.startIso)
  const end = ref.endIso ? Date.parse(ref.endIso) : NaN
  return Number.isFinite(end) && end > start ? end : start + DEFAULT_MEETING_MS
}

/** True from `endMs` on; one timer to that moment, none after. */
function useIsPast(endMs: number): boolean {
  const [now, setNow] = useState(() => Date.now())
  const past = now >= endMs
  useEffect(() => {
    if (past) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(endMs - Date.now(), 0), MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [endMs, now, past])
  return past
}

/** Under a prep report's chip: the meeting's goal (renders nothing for any other message). */
export function MeetingGoalComposer({ metadata }: { metadata?: unknown }) {
  const ref = useMemo(() => meetingOfPrepReport(metadata), [metadata])
  return ref ? <MeetingGoal meetingRef={ref} /> : null
}

function MeetingGoal({ meetingRef }: { meetingRef: MeetingPrepRef & { calendarEventId: string } }) {
  const meeting = useMemo<MeetingGoalMeeting>(
    () => ({ calendarEventId: meetingRef.calendarEventId, startsAt: meetingRef.startIso, captureId: meetingRef.captureId }),
    [meetingRef.calendarEventId, meetingRef.startIso, meetingRef.captureId],
  )
  const over = useIsPast(meetingEndMs(meetingRef))
  // A finished meeting reads nothing (Liam's flat cost: old preps in the
  // thread add no requests); it shows a goal only when this page already has it.
  const { status, goal, save } = useMeetingGoal(meeting, !over)
  const [editing, setEditing] = useState(false)
  // A save that failed: the box opens again with the words that didn't save.
  const [failed, setFailed] = useState<{ text: string; n: number } | null>(null)

  if (over) {
    return status === 'ready' && goal ? (
      <p data-meeting-goal="over" className={cn(GOAL_SPOT, GOAL_LINE, 'w-auto')}>
        <Target aria-hidden className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        Goal: <span className="text-foreground">{goal}</span>
      </p>
    ) : null
  }
  // Nothing until the read answers (no box flashing before a saved line).
  if (status === 'loading') return null
  if (goal && !editing) {
    return (
      <button
        type="button"
        data-meeting-goal="saved"
        onClick={() => setEditing(true)}
        title="Edit the goal"
        className={cn(GOAL_SPOT, GOAL_LINE, 'w-auto transition-colors hover:text-foreground')}
      >
        <Target aria-hidden className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        Goal: <span className="text-foreground">{goal}</span>
      </button>
    )
  }
  return (
    <GoalBox
      key={failed?.n ?? 0}
      initial={failed?.text ?? goal ?? ''}
      editingSaved={!!goal}
      onSave={async (text) => {
        // Saved empty: an edit clears the goal; a fresh box has nothing to clear.
        if (!text.trim() && !goal) return
        setEditing(false)
        setFailed(null)
        if (await save(text)) return
        setFailed((f) => ({ text, n: (f?.n ?? 0) + 1 }))
        setEditing(true)
      }}
      onCancel={() => {
        setFailed(null)
        setEditing(false)
      }}
    />
  )
}

/**
 * The box itself, mounted only while it shows: the dictation hooks (desktop)
 * live here, so a saved line or a past meeting holds none.
 */
function GoalBox({
  initial,
  editingSaved,
  onSave,
  onCancel,
}: {
  initial: string
  editingSaved: boolean
  onSave: (text: string) => void | Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const hostRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // Dictation: the chat composer's mic (desktop only, once on-device
  // transcription is ready). Dictated words land at the caret.
  const recording = useOptionalRecordingStable()
  const availability = useVoiceAvailability({ recording: !!(recording?.isRecording || recording?.isStarting) })
  const commit = useCallback((text: string) => {
    const ta = hostRef.current?.querySelector('textarea') ?? null
    const current = draftRef.current
    const start = ta ? ta.selectionStart : current.length
    const end = ta ? ta.selectionEnd : start
    const inserted = insertDictation(current, start, end, text)
    // Dictation writes past the field's maxLength, so the goal's limit is kept here.
    const value = inserted.value.slice(0, MEETING_GOAL_MAX_CHARS)
    const caret = Math.min(inserted.caret, value.length)
    draftRef.current = value
    setDraft(value)
    requestAnimationFrame(() => hostRef.current?.querySelector('textarea')?.setSelectionRange(caret, caret))
  }, [])
  const dictation = useDictation({
    enabled: availability.dictation && !availability.blocked,
    onCommit: commit,
    onRefused: reportVoiceRefusal,
  })

  const hasText = !!draft.trim()
  const submit = () => {
    // Enter while dictating stops it: the words land in the box to read first.
    if (dictation.active) {
      dictation.stop()
      return
    }
    if (!hasText && !editingSaved) return
    void onSave(draft)
  }

  return (
    <div ref={hostRef} data-meeting-goal="composer" className={cn(GOAL_SPOT, 'rounded-3xl')}>
      <PromptInput value={draft} onValueChange={setDraft} onSubmit={submit} maxHeight={120} className={GOAL_BOX}>
        <Target aria-hidden className="mb-2.5 h-4 w-4 shrink-0 self-end text-muted-foreground" />
        <PromptInputTextarea
          aria-label="Goal of this call"
          placeholder={dictation.active && !draft ? 'Listening…' : MEETING_GOAL_PLACEHOLDER}
          maxLength={MEETING_GOAL_MAX_CHARS}
          className="min-h-0 min-w-0 flex-1 px-0 py-1.5 text-[15px] leading-6 md:text-[15px]"
          rows={1}
          // No resize observer per card: the placeholder is short.
          hidePlaceholderBelow={0}
          autoFocus={editingSaved}
          onKeyDown={(e) => {
            // Mid-composition (an IME), Escape is the IME's; while dictating,
            // it is dictation's (it cancels the words).
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key !== 'Escape' || dictation.active) return
            e.preventDefault()
            e.stopPropagation()
            if (editingSaved) onCancel()
            else setDraft('')
          }}
        />
        <PromptInputActions className="shrink-0 gap-1">
          {hasText ? (
            <BubbleSendButton aria-label="Save goal" data-meeting-goal-send="" onClick={submit} />
          ) : (
            <DictationButton availability={availability} dictation={dictation} />
          )}
        </PromptInputActions>
      </PromptInput>
    </div>
  )
}

/**
 * set_meeting_goal's result in the chat: one quiet line, and the meeting's
 * card (if one shows it) re-reads its goal. A failed call falls through to the
 * generic chip (null here).
 */
export function meetingGoalToolResult(output: unknown): { calendarEventId: string; startsAt: string; goal: string | null } | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (o.success !== true) return null
  const calendarEventId = normalizeEventId(o.calendar_event_id)
  const startsAt = normalizeStartsAt(o.starts_at)
  if (!calendarEventId || !startsAt) return null
  return { calendarEventId, startsAt, goal: typeof o.goal === 'string' && o.goal ? o.goal : null }
}

export function MeetingGoalSetLine({ toolCallId, result }: { toolCallId: string; result: NonNullable<ReturnType<typeof meetingGoalToolResult>> }) {
  const { calendarEventId, startsAt } = result
  useEffect(() => {
    refreshMeetingGoal({ calendarEventId, startsAt }, toolCallId)
  }, [calendarEventId, startsAt, toolCallId])
  return (
    <p data-meeting-goal-set="" className="my-1 max-w-full self-start px-1 text-[13px] leading-5 text-muted-foreground">
      <Target aria-hidden className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
      {result.goal ? (
        <>
          Goal set: <span className="text-foreground">{result.goal}</span>
        </>
      ) : (
        'Goal cleared'
      )}
    </p>
  )
}
