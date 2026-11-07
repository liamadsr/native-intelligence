'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { useFloatingChatContainerRef } from './floating-chat'
import { measureChatReadingColumn } from './picker-popover'
import { QuestionPicker } from './question-picker'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'

/**
 * Floating clarifying-question panel — surfaces an unanswered ask_user prompt
 * as a popout OVER the chat (like the chat-history panel),
 * anchored just above the input, instead of inline in the message stream.
 *
 * UX (per product decision):
 *   - Dismissible ONLY via the explicit X (or Skip). Clicking elsewhere in the
 *     chat does NOT close it — outside-interaction + Esc dismissal are disabled.
 *   - Answering or skipping resolves the underlying tool call; the parent then
 *     stops passing a `question`, so the popover unmounts on its own.
 *
 * Positioning mirrors PickerPopover: anchored to the input wrapper, width matched
 * to the floating chat strip (inset so it doesn't touch the card walls).
 */
export interface QuestionPopoverProps {
  /** The open question's tool-call id + questions, or null when none is pending. */
  question: { toolCallId: string; questions: AgentQuestion[] } | null
  /** Anchor element (the chat input wrapper) the panel floats above. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Answer the question (answers map question text → label(s)). */
  onAnswer: (toolCallId: string, answers: Record<string, string>) => void
  /** Skip / dismiss with an optional free-text reply. */
  onSkip: (toolCallId: string, response?: string) => void
  /** Close via the X button — same as Skip (the agent is told nothing was chosen). */
  onClose: (toolCallId: string) => void
  /** True while the owning tab is hidden (inactive). The popover STAYS MOUNTED
   *  — unmounting would discard the QuestionPicker's partially-entered answers —
   *  but its portaled content (which escapes the hidden strip to <body>) is made
   *  display:none and inert so it neither floats over the active tab, catches
   *  its clicks, nor traps focus. Flipping back to false shows it again with
   *  state intact. */
  hidden?: boolean
}

export function QuestionPopover({
  question,
  anchorRef,
  onAnswer,
  onSkip,
  onClose,
  hidden = false,
}: QuestionPopoverProps) {
  const floatingContainerRef = useFloatingChatContainerRef()
  const open = question !== null

  // Paging reported up from the picker, shown as a "1/N" chip in the header.
  const [paging, setPaging] = useState<{ page: number; total: number }>({ page: 1, total: 1 })

  // Measure layout in an effect (not during render) — the height cap (space above
  // the anchor) and the panel width (matched to the chat strip). Re-measures on
  // open AND on every subsequent resize of the floating chat strip (drag-resize,
  // window resize, collapse/expand toggle) via ResizeObserver — same idiom as
  // dashboard-shell.tsx's strip-width tracking — so a panel left open while the
  // user drags the chat wider/narrower stays matched instead of freezing at its
  // open-time size.
  const [spaceAbove, setSpaceAbove] = useState(480)
  const [panelWidth, setPanelWidth] = useState<number | null>(null)
  useEffect(() => {
    if (!open || !anchorRef.current) return
    const measure = () => {
      if (!anchorRef.current) return
      const rect = anchorRef.current.getBoundingClientRect()
      setSpaceAbove(Math.max(rect.top - 80, 160))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(anchorRef.current)
    return () => ro.disconnect()
  }, [open, anchorRef])
  useEffect(() => {
    if (!open) return
    // Match the visible chat reading column, never the raw strip — in
    // full-screen-chat (collapsed) mode the strip is the whole window, so
    // following it makes the panel bloom wall-to-wall. Measure `.chat-reading-col`
    // (640px expanded / 634px collapsed, same as the pickers), then inset 36px
    // (20px card padding + 16px gutter) so it doesn't touch the card walls.
    const measure = () => {
      const w = measureChatReadingColumn(
        floatingContainerRef.current?.getBoundingClientRect().width ??
          anchorRef.current?.getBoundingClientRect().width ??
          360,
      )
      setPanelWidth(w - 36)
    }
    measure()
    // Observe whichever element the width is actually derived from — the
    // floating container when present, else the anchor itself.
    const target = floatingContainerRef.current ?? anchorRef.current
    if (!target) return
    const ro = new ResizeObserver(measure)
    ro.observe(target)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!question) return null

  return (
    <Popover open={open}>
      <PopoverAnchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        // display:none (not conditional rendering) while the tab is hidden: the
        // picker's answer draft must survive. Not `invisible`: Radix positions
        // this content inside its own portaled `[data-radix-popper-content-wrapper]`
        // div, which this className never reaches, so the wrapper kept the panel's
        // full rect over the active tab and caught its clicks. A display:none child
        // collapses that wrapper to 0×0. `inert` (React 19 boolean) pulls the
        // hidden content out of the tab order.
        className="overflow-hidden rounded-2xl border border-border bg-background p-0 shadow-md"
        aria-hidden={hidden || undefined}
        inert={hidden}
        // Never closes on an outside press, so never keeps a full-screen card from closing on one.
        data-full-screen-ignore=""
        style={{ width: panelWidth ?? undefined, display: hidden ? 'none' : undefined }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Dismiss ONLY via the X / Skip — clicking the chat or pressing Esc must
        // NOT close it (the agent is waiting on a real answer).
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            {paging.total > 1 && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {paging.page}/{paging.total}
              </span>
            )}
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Question for you
            </span>
          </div>
          <button
            type="button"
            aria-label="Dismiss question"
            onClick={() => onClose(question.toolCallId)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          className="overflow-y-auto p-2 scrollbar-hide-deep"
          style={{ maxHeight: Math.min(spaceAbove - 60, 520) }}
        >
          <QuestionPicker
            // Remount per question so internal selection state resets cleanly.
            key={question.toolCallId}
            questions={question.questions}
            onSubmit={(answers) => onAnswer(question.toolCallId, answers)}
            onSkip={(response) => onSkip(question.toolCallId, response ?? '(skipped)')}
            onPageChange={(page, total) => setPaging({ page, total })}
            bare
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
