'use client'

/**
 * The HUD's goal line (live sidekick plan, Phase 5; lib/live-agent/hud-goal.ts):
 * the person's goal for the call, set or changed during it.
 *   - with a goal: "Goal" and the goal on one truncated glass line; a click
 *     (while the call is live) edits it in place, one line: Enter saves,
 *     Escape (or leaving the field) cancels, saving it empty clears it;
 *   - with none: a quiet "Set a goal", only while the call is live (the one
 *     exception to hiding what's empty: it's the way in). Not live and no
 *     goal: nothing.
 * A save shows the new goal at once and keeps it while the host's answer is
 * out; a failed one puts the old goal back and says "Not saved" until the
 * next edit. Enter while an IME composes is the composition's, not a save.
 * Plain text only. No timers.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { BOT_GLASS, BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { MEETING_GOAL_MAX_CHARS } from '@/lib/meetings/meeting-goal'

export interface HudGoalLineProps {
  /** The goal as the host last read it (the brief's); null when none. */
  goal: string | null
  /** The call is live (recording, not finishing up): editing and "Set a goal" only then. */
  live: boolean
  /** Save the goal ('' clears it). Resolves false when it wasn't saved. */
  onSave: (goal: string) => Promise<boolean>
}

export function HudGoalLine({ goal, live, onSave }: HudGoalLineProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // A save in flight or done, shown over `goal` until the host's goal moves
  // on from the one it replaced ('' = cleared).
  const [pending, setPending] = useState<{ text: string; base: string | null } | null>(null)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  // The host's goal moved on (the new brief, or someone else's change): it wins.
  if (pending && pending.base !== goal) setPending(null)
  const current = (pending && pending.base === goal ? pending.text : goal) || null

  const start = () => {
    if (!live) return
    setDraft(current ?? '')
    setFailed(false)
    setEditing(true)
  }
  const cancel = () => setEditing(false)
  const commit = () => {
    setEditing(false)
    const text = draft.trim()
    if (text === (current ?? '')) return
    const mine = ++seq.current
    setPending({ text, base: goal })
    setFailed(false)
    void onSave(text)
      .catch(() => false)
      .then((ok) => {
        if (ok || seq.current !== mine) return
        setPending(null)
        setFailed(true)
      })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An IME's Enter picks its candidate.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      // Ours: the web HUD's own Escape (collapse the chat) leaves it be.
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }

  const notSaved = failed ? (
    <span data-hud-goal-failed="" className="shrink-0 text-[11px] text-destructive">
      Not saved
    </span>
  ) : null

  if (editing) {
    return (
      <div
        data-hud-goal=""
        data-editing=""
        className={cn(BOT_GLASS, 'flex shrink-0 min-w-0 items-center gap-2 rounded-[18px] px-3 py-1.5 text-[12px]')}
      >
        <span className="shrink-0 font-medium text-foreground">Goal</span>
        <input
          autoFocus
          type="text"
          aria-label="The call's goal"
          enterKeyHint="done"
          maxLength={MEETING_GOAL_MAX_CHARS}
          placeholder="What do you want out of this call?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={cancel}
          className={cn('min-w-0 flex-1 bg-transparent text-foreground outline-none', 'placeholder:text-muted-foreground/70')}
        />
      </div>
    )
  }

  if (current) {
    return (
      <div data-hud-goal="" className={cn(BOT_GLASS, 'shrink-0 overflow-hidden rounded-[18px]')}>
        <button
          type="button"
          onClick={start}
          disabled={!live}
          aria-label={live ? `Goal: ${current}. Edit` : `Goal: ${current}`}
          className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors enabled:hover:bg-black/[0.04] disabled:cursor-default dark:enabled:hover:bg-white/[0.06]"
        >
          <span className="shrink-0 font-medium text-foreground">Goal</span>
          <span data-hud-goal-text="" className={cn('min-w-0 flex-1 truncate', BOT_GLASS_MUTED)}>
            {current.replace(/\s+/g, ' ')}
          </span>
          {notSaved}
        </button>
      </div>
    )
  }

  if (!live) return null
  return (
    <button
      type="button"
      data-hud-goal=""
      data-hud-goal-set=""
      onClick={start}
      className={cn(
        '-my-0.5 flex shrink-0 items-center gap-2 self-start px-3 text-left text-[11px] leading-4 transition-colors hover:text-foreground',
        BOT_GLASS_MUTED,
      )}
    >
      Set a goal
      {notSaved}
    </button>
  )
}
