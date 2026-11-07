'use client'

/**
 * The side panel's Context card (Liam, 10-22, after the Claude app's Context
 * panel: "a new context panel that works just like the one on the Claude
 * desktop app, with an option to compact on command"): how full the main
 * chat's conversation is, by part, and Compact now. Its card and its
 * "Context" row are the panel's (side-panels.tsx PanelSection); the row's
 * summary is contextSummary below ("18%", or "Compacted"). Opened:
 *
 *   18% used                 45.2k / 250k
 *   [the bar: one segment per part, then the free space, then the buffer]
 *   ■ Messages        28.1k   11.2%     the conversation: the rest of the input
 *   ■ System prompt    9.8k    3.9%     ┐
 *   ■ Tools            5.2k    2.1%     │ the agent's own, estimated
 *   ■ Skills           1.1k    0.4%     │ (agents/chat-agent/lib/context-parts.ts);
 *   ■ Memory           1.0k    0.4%     ┘ a part at 0 shows no row
 *   □ Free space     184.8k   73.9%
 *   ▨ Compaction buffer 25k   10.0%     eve compacts inside a reply past it
 *   [        Compact now        ]       past COMPACT_BUTTON_SHARE of the window only
 *   Compacts on its own past 150k, between messages.
 *
 * The window is the chat's working window, not the model's (src/lib/chat/
 * context-usage.ts says why). After a compaction the size is unknown until
 * the next message, so the card says so and lists the agent's parts alone.
 * A turn from before the parts were measured shows its size as one part.
 *
 * Compact now (and `/compact`) asks the server to compact now
 * (src/lib/chat/context-client.ts). The button (Liam, 10-22: "more like a
 * button so it's clear it's a button", shown "only when more than 60% of the
 * available context window is used up") is an outlined, full-width button
 * that shows once the context passes COMPACT_BUTTON_SHARE of the window; off
 * while a reply runs or one is already compacting. `/compact` works at any
 * size. Its outcome is the line under it. The data is read when the
 * panel opens and after each reply (never polled); no animation but the
 * button's spinner.
 */
import { memo } from 'react'
import { Loader2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { compactChatContext, type ChatContextState } from '@/lib/chat/context-client'
import type { ChatContextUsage, ContextPartKey } from '@/lib/chat/context-usage'

/** The share of the window past which the card offers Compact now (`/compact` works at any size). */
export const COMPACT_BUTTON_SHARE = 0.6

/** Whether the card offers Compact now: a measured context past COMPACT_BUTTON_SHARE of the window. */
export function offersCompact(context: ChatContextUsage): boolean {
  return context.compactedAt === null && context.usedTokens !== null && context.usedTokens / context.windowTokens > COMPACT_BUTTON_SHARE
}

/** Each part's name and colour (the bar's segment and the row's swatch). */
export const PART_STYLE: Record<ContextPartKey, { label: string; swatch: string }> = {
  messages: { label: 'Messages', swatch: 'bg-blue-500 dark:bg-blue-400' },
  system: { label: 'System prompt', swatch: 'bg-amber-500 dark:bg-amber-400' },
  tools: { label: 'Tools', swatch: 'bg-orange-500 dark:bg-orange-400' },
  skills: { label: 'Skills', swatch: 'bg-emerald-500 dark:bg-emerald-400' },
  memory: { label: 'Memory', swatch: 'bg-violet-500 dark:bg-violet-400' },
}

/** A token count as the Claude app writes it: 812, 45.2k, 250k, 1M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) return `${trim((n / 1000).toFixed(1))}k`
  return `${trim((n / 1_000_000).toFixed(1))}M`
}

function trim(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/** A share of the window, one decimal: 11.2%. */
export function formatShare(tokens: number, window: number): string {
  return `${window > 0 ? ((tokens / window) * 100).toFixed(1) : '0.0'}%`
}

/**
 * The share of the window used, a whole percent, at most 100: a model call's
 * input can pass the working window (eve compacts before the next call), and
 * the card then reads full, its size still the true one.
 */
export function usedPercent(context: Pick<ChatContextUsage, 'usedTokens' | 'windowTokens'>): number {
  if (context.usedTokens === null || context.windowTokens <= 0) return 0
  return Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))
}

/** The card's row summary: the share used, "Compacted" after a compaction, or null with nothing to show (the card hides then). */
export function contextSummary(context: ChatContextUsage | null): string | null {
  if (!context) return null
  if (context.compactedAt) return 'Compacted'
  if (context.usedTokens === null) return null
  return `${usedPercent(context)}%`
}

/** One row of the card's list: a part, the free space or the buffer. */
interface ContextRow {
  key: string
  label: string
  tokens: number | null
  swatch: string
}

/** The rows, in the bar's order: the measured parts (none at 0), the free space, the buffer. Pure. */
export function contextRows(context: ChatContextUsage): ContextRow[] {
  const rows: ContextRow[] = []
  const compacted = context.compactedAt !== null
  if (compacted) rows.push({ key: 'messages', label: 'Messages', tokens: null, swatch: PART_STYLE.messages.swatch })
  if (context.parts) {
    for (const part of context.parts) {
      if (part.tokens > 0) rows.push({ key: part.key, label: PART_STYLE[part.key].label, tokens: part.tokens, swatch: PART_STYLE[part.key].swatch })
    }
  } else if (context.usedTokens !== null) {
    rows.push({ key: 'used', label: 'In use', tokens: context.usedTokens, swatch: PART_STYLE.messages.swatch })
  }
  const used = rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
  const buffer = Math.max(0, context.windowTokens - Math.max(context.compactAtTokens, used))
  const free = Math.max(0, context.windowTokens - used - buffer)
  if (!compacted) rows.push({ key: 'free', label: 'Free space', tokens: free, swatch: 'bg-muted-foreground/15' })
  rows.push({ key: 'buffer', label: 'Compaction buffer', tokens: buffer, swatch: BUFFER_SWATCH })
  return rows
}

/** The buffer's hatch: the space eve keeps for compacting inside a reply. */
const BUFFER_SWATCH = 'bg-[repeating-linear-gradient(135deg,var(--color-muted-foreground)_0_1px,transparent_1px_4px)] opacity-40'

export const ContextSection = memo(function ContextSection({
  state,
  busy,
}: {
  state: ChatContextState
  /** A reply is running in the main chat: Compact now waits for it. */
  busy: boolean
}) {
  const { context, compacting, note, conversationId } = state
  if (!context || !conversationId) return null
  const compacted = context.compactedAt !== null
  const rows = contextRows(context)
  const window = context.windowTokens
  const used = context.usedTokens
  const disabled = busy || compacting
  const why = busy ? 'Wait for the reply to finish' : compacting ? 'Compacting…' : 'Summarize the conversation so far, to free up room'
  return (
    // The card, its row and its body's box are the panel's (side-panels.tsx PanelSection).
    <div data-context-section="" className="px-3 pb-1">
      <div className="flex items-baseline justify-between gap-3 pt-0.5">
        <span data-context-used="" className="text-[15px] font-medium tabular-nums text-foreground">
          {compacted ? 'Compacted' : `${usedPercent(context)}% used`}
        </span>
        <span data-context-total="" className="text-[12px] tabular-nums text-muted-foreground">
          {compacted ? '—' : formatTokens(used ?? 0)} / {formatTokens(window)}
        </span>
      </div>
      <ContextBar rows={rows} window={window} />
      <ul data-context-parts="" className="mt-2.5 space-y-1">
        {rows.map((row) => (
          <li key={row.key} data-context-part={row.key} className="flex h-6 items-center gap-2.5 text-[13px]">
            <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', row.swatch)} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
            <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{row.tokens === null ? 'Summary' : formatTokens(row.tokens)}</span>
            <span className="w-12 shrink-0 text-right tabular-nums text-foreground">{row.tokens === null ? '—' : formatShare(row.tokens, window)}</span>
          </li>
        ))}
      </ul>
      {compacted && (
        <p data-context-compacted="" className="mt-2 text-[12px] leading-4 text-muted-foreground">
          The next message starts from a summary. Its size shows then.
        </p>
      )}
      {(offersCompact(context) || compacting) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-context-compact=""
          disabled={disabled}
          aria-busy={compacting || undefined}
          title={why}
          onClick={() => void compactChatContext(conversationId)}
          className="mt-3 h-8 w-full border border-border text-[12px] [&_svg]:size-3.5"
        >
          {compacting ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Minimize2 aria-hidden />}
          {compacting ? 'Compacting…' : 'Compact now'}
        </Button>
      )}
      {!note && !compacting && !compacted && (
        <p data-context-hint="" className="mt-2 text-[12px] leading-4 text-muted-foreground">
          {busy && offersCompact(context)
            ? 'Compact once the reply finishes.'
            : `Compacts on its own past ${formatTokens(context.idleCompactTokens)}, between messages.`}
        </p>
      )}
      {note && (
        <p
          data-context-note=""
          role="status"
          className={cn('mt-2 pb-0.5 text-[12px] leading-4', note.tone === 'attention' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}
        >
          {note.text}
        </p>
      )}
    </div>
  )
})

/** The bar: each row's share of the window, in order, on the compositor-free path (plain widths, no animation). */
function ContextBar({ rows, window }: { rows: ContextRow[]; window: number }) {
  const label = rows
    .filter((r) => r.tokens !== null && r.key !== 'free' && r.key !== 'buffer')
    .map((r) => `${r.label} ${formatTokens(r.tokens ?? 0)}`)
    .join(', ')
  return (
    <div
      role="img"
      aria-label={label ? `Context: ${label}, of ${formatTokens(window)}` : `Context window ${formatTokens(window)}`}
      data-context-bar=""
      className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
    >
      {rows.map((row) =>
        row.tokens && row.key !== 'free' ? (
          <span
            key={row.key}
            className={cn('h-full shrink-0', row.swatch, row.key === 'buffer' && 'ml-auto')}
            style={{ width: `${(row.tokens / window) * 100}%`, minWidth: row.tokens > 0 ? 2 : 0 }}
          />
        ) : null,
      )}
    </div>
  )
}
