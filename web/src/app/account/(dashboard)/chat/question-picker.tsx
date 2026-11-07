'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useModKeyLabel } from '@/lib/hotkeys'
import { Button } from '@/components/ui/button'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'

/**
 * The clickable clarifying-question widget for the agents' `ask_user` tool
 * (header chip, 2–4 options with descriptions, single/multi-select, an
 * always-present "Other" free-text row, and Skip). The answer goes through the
 * transport's answerPermission (inputResponses on the same eve session), which
 * resumes the parked turn. The parent owns the round-trip; this component only
 * collects selections.
 *
 * Multiple questions are paged (1/N); all answers are collected before submit.
 * The `answers` map sent to onSubmit keys each question's TEXT to the chosen
 * label (a `", "`-joined string for multi-select, or the typed text for Other),
 * matching the shape the transports expect.
 */

const OTHER = '__other__'

export interface QuestionPickerProps {
  questions: AgentQuestion[]
  /** All questions answered. `answers` maps question text → chosen label(s)/text. */
  onSubmit: (answers: Record<string, string>) => void
  /** User dismissed the card without answering (free-text reply or plain skip). */
  onSkip: (response?: string) => void
  /** Locked after the answer has been sent (renders read-only). */
  disabled?: boolean
  /** Drop the outer card chrome (border/bg/padding) — used when the picker is
   *  hosted inside the QuestionPopover, which provides its own chrome. */
  bare?: boolean
  /** Reports the current paging (1-based page + total) so a host header can show
   *  the "1/N" indicator instead of the picker body. */
  onPageChange?: (page: number, total: number) => void
  /** Take focus as it mounts, so ⌘↵ works at once (the default). Off where it
   *  mounts unasked beside something you type in (the chat's For you column). */
  autoFocus?: boolean
}

/** Per-question working selection: a set of chosen option labels + Other text. */
interface Selection {
  labels: Set<string>
  otherText: string
  otherActive: boolean
}

export function QuestionPicker({ questions: rawQuestions, onSubmit, onSkip, disabled, bare, onPageChange, autoFocus = true }: QuestionPickerProps) {
  // Normalize: the model/CLI doesn't guarantee well-formed shapes — a question
  // can arrive with options missing/null or a non-array, which would crash
  // `q.options.map`. Coerce every question to a safe array of valid options so
  // the rest of the component can assume it's always present.
  const questions = useMemo<AgentQuestion[]>(
    () =>
      (Array.isArray(rawQuestions) ? rawQuestions : [])
        .filter((q): q is AgentQuestion => Boolean(q) && typeof q.question === 'string')
        .map((q) => ({
          ...q,
          options: (Array.isArray(q.options) ? q.options : []).filter(
            (o): o is AgentQuestion['options'][number] =>
              Boolean(o) && typeof o.label === 'string',
          ),
        })),
    [rawQuestions],
  )

  const [page, setPage] = useState(0)
  const [sel, setSel] = useState<Selection[]>(() =>
    questions.map(() => ({ labels: new Set<string>(), otherText: '', otherActive: false })),
  )

  const total = questions.length
  const q = questions[page]
  // Fall back to an empty selection if the slot is missing (defensive — keeps
  // every `cur.labels`/`cur.otherText` read safe even if sel/questions desync).
  // Memoized so the fallback identity is stable across renders (the callbacks
  // below depend on `cur`).
  const cur = useMemo<Selection>(
    () => sel[page] ?? { labels: new Set<string>(), otherText: '', otherActive: false },
    [sel, page],
  )
  const isLast = page === total - 1

  // Report paging up so the host (QuestionPopover) can render the "1/N" indicator
  // in its header instead of the picker body. Keep the callback in a ref so the
  // effect depends ONLY on page/total — callers usually pass an inline arrow
  // whose identity changes every render, which would otherwise loop.
  const onPageChangeRef = useRef(onPageChange)
  useEffect(() => {
    onPageChangeRef.current = onPageChange
  })
  useEffect(() => {
    onPageChangeRef.current?.(page + 1, total)
  }, [page, total])

  const update = useCallback((i: number, next: Partial<Selection>) => {
    setSel((prev) => {
      const copy = [...prev]
      // Seed a default if the slot doesn't exist yet (sel can lag a
      // re-normalized `questions`), so the result always has all fields.
      const base = copy[i] ?? { labels: new Set<string>(), otherText: '', otherActive: false }
      copy[i] = { ...base, ...next }
      return copy
    })
  }, [])

  const toggleOption = useCallback(
    (label: string) => {
      if (disabled) return
      const labels = new Set(cur.labels)
      if (q.multiSelect) {
        if (labels.has(label)) labels.delete(label)
        else labels.add(label)
        update(page, { labels, otherActive: false })
      } else {
        // Single-select: picking an option replaces any prior choice + clears Other.
        update(page, { labels: new Set([label]), otherActive: false })
      }
    },
    [cur, q, page, disabled, update],
  )

  const chooseOther = useCallback(() => {
    if (disabled) return
    // Single-select: Other replaces the chosen option. Multi: Other coexists.
    update(page, {
      otherActive: true,
      labels: q.multiSelect ? cur.labels : new Set<string>(),
    })
  }, [cur, q, page, disabled, update])

  /** The resolved answer string for one question, or '' if nothing chosen. */
  const answerFor = useCallback((i: number): string => {
    // Guard: `sel` can briefly lag `questions` (re-normalization changes the
    // length), so a slot may not exist yet — treat a missing one as "unanswered".
    const s = sel[i]
    if (!s) return ''
    const parts = [...s.labels]
    if (s.otherActive && s.otherText.trim()) parts.push(s.otherText.trim())
    return parts.join(', ')
  }, [sel])

  const curAnswered = answerFor(page).length > 0
  const allAnswered = useMemo(
    () => questions.every((_, i) => answerFor(i).length > 0),
    [questions, answerFor],
  )

  // Whether the current page's Next/Submit action is available — mirrors the
  // button's disabled state, so the ⌘/Ctrl+Return shortcut and the button agree.
  const canAdvance = !disabled && curAnswered && !(isLast && !allAnswered)

  const handleNext = useCallback(() => {
    if (disabled) return
    if (!isLast) {
      if (!curAnswered) return
      setPage((p) => Math.min(p + 1, total - 1))
      return
    }
    if (!allAnswered) return
    const answers: Record<string, string> = {}
    questions.forEach((qq, i) => {
      answers[qq.question] = answerFor(i)
    })
    onSubmit(answers)
  }, [disabled, isLast, total, curAnswered, allAnswered, questions, answerFor, onSubmit])

  // ⌘+Return (Ctrl+Return on Windows/Linux) advances / submits — same as the
  // Next/Submit button, so the user never has to reach for the mouse. Bound on
  // the root so it works whether focus is on an option button or the Other input.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleNext()
      }
    },
    [handleNext],
  )

  // Focus the root on mount so ⌘+Return works immediately — the host popover
  // suppresses its own auto-focus, so nothing inside is focused otherwise.
  const rootRef = useRef<HTMLDivElement>(null)
  const advanceKey = useModKeyLabel('↵')
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true })
    // Once, as it mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!q) return null

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex flex-col gap-3 text-sm outline-none',
        bare ? 'p-1' : 'rounded-xl border border-border/60 bg-card/40 p-3.5',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      {/* Header: question header chip + text (the "1/N" pager lives in the host
          popover's top header — see QuestionPopover). */}
      <div className="flex flex-col gap-0.5">
        {q.header && (
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {q.header}
          </span>
        )}
        <span className="font-medium leading-snug text-foreground">{q.question}</span>
      </div>

      {/* Options */}
      <div className="flex flex-col gap-1.5">
        {q.options.map((opt, idx) => {
          const selected = cur.labels.has(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              disabled={disabled}
              onClick={() => toggleOption(opt.label)}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                selected
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border/50 bg-muted/20 hover:bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-medium',
                  selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {idx + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium leading-snug text-foreground">{opt.label}</span>
                {opt.description && (
                  <span className="text-[12px] leading-snug text-muted-foreground">
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          )
        })}

        {/* Other / free-text — always available, mirroring the native picker. */}
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-3 py-2',
            cur.otherActive ? 'border-primary/60 bg-primary/10' : 'border-border/50 bg-muted/20',
          )}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={chooseOther}
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-medium',
              cur.otherActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            {q.options.length + 1}
          </button>
          <div className="flex flex-1 flex-col gap-1">
            <button
              type="button"
              disabled={disabled}
              onClick={chooseOther}
              className="text-left font-medium leading-snug text-foreground"
            >
              Other
            </button>
            <input
              type="text"
              value={cur.otherText}
              disabled={disabled}
              placeholder="Type your own answer"
              onFocus={chooseOther}
              onChange={(e) => update(page, { otherText: e.target.value, otherActive: true })}
              className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Footer: Back on the far left; Skip + Next/Submit grouped on the right. */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        {total > 1 && page > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-7 px-2.5 text-xs"
            onClick={() => setPage((p) => Math.max(p - 1, 0))}
          >
            Back
          </Button>
        ) : (
          // Spacer keeps Skip + Next right-aligned when there's no Back button.
          <span />
        )}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onSkip()}
          >
            Skip
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canAdvance}
            className="h-7 gap-1.5 px-3 text-xs"
            onClick={handleNext}
            title={`${isLast ? 'Submit' : 'Next'} (${advanceKey})`}
          >
            {isLast ? 'Submit' : 'Next'}
            <kbd className="rounded bg-primary-foreground/15 px-1 text-[10px] leading-none text-primary-foreground/80">
              {advanceKey}
            </kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The compact, read-only summary shown once a question card has been answered. */
export function AnsweredQuestionsSummary({
  answers,
}: {
  answers: Record<string, string>
}) {
  const entries = Object.entries(answers)
  if (entries.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/50 bg-muted/20 p-3 text-sm">
      {entries.map(([question, answer]) => (
        <div key={question} className="flex flex-col gap-0.5">
          <span className="text-[12px] leading-snug text-muted-foreground">{question}</span>
          <span className="font-medium leading-snug text-foreground">{answer || OTHER}</span>
        </div>
      ))}
    </div>
  )
}
