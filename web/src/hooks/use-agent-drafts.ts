'use client'

/**
 * The email drafts the person's bots wrote that still wait in Mail
 * (src/lib/email/agent-drafts.ts): the For you column's draft cards.
 *
 * One store for the window, however many read it (the column and its
 * toggle's count): it starts with its first reader and stops with its last.
 * Flat cost: one read when it starts, then again only when a draft changes
 * (the workspace's Realtime fan-out, entity-events.ts, settled for a second
 * so a pass's burst is one read) or the window comes back after a minute
 * away. Nothing polls. A failed read keeps what it had.
 */
import { useSyncExternalStore } from 'react'
import { onEntityDeleted, onEntityUpdated } from '@/lib/entity-events'
import type { AgentDraft } from '@/lib/email/agent-drafts'

const NO_DRAFTS: AgentDraft[] = []
/** A draft change waits this long for its neighbours before one read. */
const SETTLE_MS = 1_000
/** Back in the window after this long: read again. */
const STALE_MS = 60_000

let drafts: AgentDraft[] = NO_DRAFTS
const listeners = new Set<() => void>()
let stop: (() => void) | null = null

function set(next: AgentDraft[]) {
  drafts = next
  for (const l of listeners) l()
}

function start(): () => void {
  let alive = true
  let lastRead = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const read = async () => {
    lastRead = Date.now()
    try {
      const res = await fetch('/api/account/email/agent-drafts', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { drafts?: unknown }
      if (alive && Array.isArray(data.drafts)) set(data.drafts as AgentDraft[])
    } catch {
      // Keep what it had.
    }
  }
  const soon = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void read(), SETTLE_MS)
  }
  const onDraft = (d: { entityType?: string } | null | undefined) => {
    if (d?.entityType === 'email_draft') soon()
  }
  const onCreated = (e: Event) => onDraft((e as CustomEvent<{ entityType?: string }>).detail)
  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRead > STALE_MS) void read()
  }
  void read()
  const offUpdated = onEntityUpdated(onDraft)
  const offDeleted = onEntityDeleted(onDraft)
  window.addEventListener('dial8:entity-created', onCreated)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    alive = false
    if (timer) clearTimeout(timer)
    offUpdated()
    offDeleted()
    window.removeEventListener('dial8:entity-created', onCreated)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) stop = start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stop?.()
      stop = null
      drafts = NO_DRAFTS
    }
  }
}

const getSnapshot = () => drafts
const getServerSnapshot = () => NO_DRAFTS
const subscribeNone = () => () => {}

/** The open drafts, or none while `enabled` is false (nothing is read then). */
export function useAgentDrafts(enabled: boolean): AgentDraft[] {
  return useSyncExternalStore(enabled ? subscribe : subscribeNone, enabled ? getSnapshot : getServerSnapshot, getServerSnapshot)
}
