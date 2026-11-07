'use client'

import { memo, useCallback, useId, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { cn } from '@/lib/utils'

/**
 * The "Thinking" line for a `reasoning` UI part.
 *
 * Some models (DeepSeek V4 Flash among them, this app's default) reason before
 * answering, and until this component existed that reasoning was invisible:
 * the model could spend a large fraction of a turn's wall-clock time in it with
 * NOTHING on screen (see eve-chat-transport.ts's `reasoning.appended` case for
 * the live trace that found this). Both chat paths now project it as a native
 * AI SDK `reasoning` part (`ReasoningUIPart`: `type`, `text`, `state:
 * 'streaming' | 'done'`).
 *
 * ONE line, collapsed by default: while the model reasons it reads "Thinking"
 * with a light sweeping across it (ShimmerText), and the moment the part closes
 * it settles to a static "Thought for a bit". The reasoning text itself is not
 * in the thread: it mounts only when the person opens the line (an accessible
 * disclosure, `aria-expanded`), live while it is still streaming, and goes
 * again when they close it. So a growing block of text never re-renders on
 * every token unless someone asked to read it.
 *
 * `state` is undefined for a part rehydrated from persisted history (the
 * hand-rolled eve projection doesn't stamp one, and a fully-formed part read
 * back from storage has no live stream to be 'streaming' from): treated as
 * 'done', matching how a reloaded tool call is always settled.
 */

export interface ReasoningCardProps {
  text: string
  /** 'streaming' while live; 'done' or undefined (persisted history) once settled. */
  state?: 'streaming' | 'done'
  className?: string
}

/** The disclosure row. Memoized: its props stay the same on every streamed token. */
const ReasoningHeader = memo(function ReasoningHeader({
  streaming,
  expanded,
  panelId,
  onToggle,
}: {
  streaming: boolean
  expanded: boolean
  panelId: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      data-reasoning-state={streaming ? 'streaming' : 'done'}
      className="group/reasoning flex w-fit items-center gap-2 py-1 text-left"
    >
      <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
      {streaming ? (
        <ShimmerText active className="text-sm font-medium">Thinking</ShimmerText>
      ) : (
        <span className="text-sm font-medium text-muted-foreground transition-colors group-hover/reasoning:text-foreground">
          Thought for a bit
        </span>
      )}
      <ChevronDown
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
          expanded && 'rotate-180',
        )}
      />
    </button>
  )
})

function ReasoningCardImpl({ text, state, className }: ReasoningCardProps) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  // Stable for the card's life, so the memoized header bails on every token.
  const toggle = useCallback(() => setExpanded((v) => !v), [])
  const streaming = state === 'streaming'

  // Nothing to show yet: reasoning-start fired but no delta has landed. Render
  // nothing rather than an empty shell; the turn-level "thinking" orb
  // (chat-panel) already covers this instant.
  if (!text.trim()) return null

  return (
    <div className={cn('my-0.5 flex flex-col gap-1', className)}>
      <ReasoningHeader streaming={streaming} expanded={expanded} panelId={panelId} onToggle={toggle} />
      {expanded && (
        <p id={panelId} className="whitespace-pre-wrap pl-6 text-xs leading-relaxed text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  )
}

/**
 * Memoized for the same reason `Tool`/`WebSearchCard` are: the parent re-walks
 * every part on each streamed token, and a settled reasoning part's props are
 * referentially stable once closed, so shallow compare bails after the turn ends.
 */
export const ReasoningCard = memo(ReasoningCardImpl)
