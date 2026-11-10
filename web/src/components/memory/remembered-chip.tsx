'use client'

/**
 * The "Remembered: …" chip under a `remember` call in the chat (one-agent
 * plan Part 3, "Memory"). It says what was saved and offers Undo, which
 * deletes the line. A workspace line from a non-admin is only proposed, so
 * the chip says it waits for an admin, and Undo withdraws it. A line that
 * was already there (`already`) says so and has no Undo: this call didn't
 * make it, so it isn't this chip's to take back.
 *
 * A fact about the person (scope 'profile', migration 328) says
 * "Remembered about you" and its Undo deletes the fact
 * (/api/account/memory/profile/:id). One whose quote could not be found in
 * the person's own recent words is only a suggestion: the chip says it waits in
 * What Native Intelligence has learned, and Undo withdraws it.
 *
 * Standalone on purpose: today's chat wires it with one branch in
 * renderToolPart (chat-message.tsx); P1's tool-renderer registry takes it as
 * the renderer for `remember`.
 */
import { useCallback, useState } from 'react'
import { Lightbulb, Undo2 } from 'lucide-react'
import { isAreaKey, PACKS, type AreaKey } from '@/lib/packs/registry'
import { isMemoryScope, type MemoryScope, type MemoryStatus } from '@/lib/packs/memory-types'
import { cn } from '@/lib/utils'

/** Where a `remember` call saved: an area note's scope, or the person's profile. */
export type RememberedScope = MemoryScope | 'profile'

export interface RememberedData {
  id: string
  /** The note's area; null for a fact about the person (scope 'profile'). */
  area: AreaKey | null
  scope: RememberedScope
  status: MemoryStatus
  text: string
  /** The line was already there: this call saved nothing. */
  already: boolean
}

/** The chip's data off a `remember` result, or null when the call saved nothing (a result is data). */
export function rememberedFromToolOutput(output: unknown): RememberedData | null {
  if (!output || typeof output !== 'object') return null
  const o = output as { success?: unknown; remembered?: unknown }
  if (o.success !== true || !o.remembered || typeof o.remembered !== 'object') return null
  const r = o.remembered as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || typeof r.text !== 'string') return null
  const profile = r.scope === 'profile'
  if (!profile && (!isAreaKey(r.area) || !isMemoryScope(r.scope))) return null
  return {
    id: r.id,
    area: profile ? null : (r.area as AreaKey),
    scope: profile ? 'profile' : (r.scope as MemoryScope),
    status: r.status === 'proposed' ? 'proposed' : 'active',
    text: r.text,
    already: (output as { already?: unknown }).already === true,
  }
}

/** The chip's sentence for a saved line. */
export function rememberedLabel(data: RememberedData): string {
  if (data.scope === 'profile') {
    // A profile fact whose quote was not verified waits for the person.
    if (data.status === 'proposed') return data.already ? `Already waiting for you: ${data.text}` : `Waiting for you in What Native Intelligence has learned: ${data.text}`
    return data.already ? `Already remembered about you: ${data.text}` : `Remembered about you: ${data.text}`
  }
  const proposed = data.status === 'proposed' && data.scope === 'workspace'
  if (data.already) return proposed ? `Already proposed to the workspace: ${data.text}` : `Already remembered: ${data.text}`
  return proposed ? `Proposed to the workspace: ${data.text}` : `Remembered: ${data.text}`
}

type UndoState = 'idle' | 'undoing' | 'undone' | 'settled' | 'failed'

/**
 * Delete the line this call made. 'gone' when it is (a 404 counts only where
 * nobody else could have changed it: a personal line, or a workspace line
 * that was active from the start); 'settled' when a member's proposal is no
 * longer theirs to withdraw because an admin settled it; 'failed' otherwise.
 */
export async function undoRemembered(data: Pick<RememberedData, 'id' | 'scope' | 'status'>): Promise<'gone' | 'settled' | 'failed'> {
  const path = data.scope === 'profile' ? '/api/account/memory/profile/' : '/api/account/memory/'
  try {
    const res = await fetch(`${path}${encodeURIComponent(data.id)}`, { method: 'DELETE' })
    if (res.ok) return 'gone'
    if (res.status === 404) return data.scope === 'workspace' && data.status === 'proposed' ? 'settled' : 'gone'
    return 'failed'
  } catch {
    return 'failed'
  }
}

export function RememberedChip({ data }: { data: RememberedData }) {
  const [undo, setUndo] = useState<UndoState>('idle')

  const onUndo = useCallback(async () => {
    setUndo('undoing')
    const result = await undoRemembered(data)
    setUndo(result === 'gone' ? 'undone' : result)
  }, [data])

  const area = data.area ? PACKS[data.area].name : 'About you'
  const scopeNote =
    data.scope === 'workspace'
      ? data.status === 'proposed'
        ? 'Waiting for an admin'
        : 'For the workspace'
      : data.scope === 'profile'
        ? data.status === 'proposed'
          ? 'Accept it to remember'
          : 'Every workspace'
        : null
  const canUndo = !data.already && undo !== 'settled'

  if (undo === 'undone') {
    return (
      <div data-testid="remembered-chip" className="my-1 inline-flex items-center gap-1.5 self-start rounded-full border border-border/60 px-3 py-1.5 text-sm text-muted-foreground">
        <Undo2 className="h-3.5 w-3.5" />
        {data.status === 'proposed' ? 'Proposal withdrawn' : 'Forgotten'}
      </div>
    )
  }

  return (
    <div
      data-testid="remembered-chip"
      className="my-1 inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm"
    >
      <Lightbulb className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={`${area}: ${data.text}`}>
        {rememberedLabel(data)}
      </span>
      {scopeNote && undo !== 'settled' && <span className="shrink-0 text-xs text-muted-foreground">{scopeNote}</span>}
      {undo === 'settled' && <span className="shrink-0 text-xs text-muted-foreground">An admin already settled it</span>}
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undo === 'undoing'}
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground',
            undo === 'undoing' && 'opacity-60',
          )}
        >
          {undo === 'failed' ? 'Undo failed, retry' : 'Undo'}
        </button>
      )}
    </div>
  )
}
