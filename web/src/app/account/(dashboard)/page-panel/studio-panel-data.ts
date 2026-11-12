'use client'

/**
 * The Studio's list for its sub-nav (./studio-panel.tsx): its Studio projects
 * and their videos, and the videos in none (`GET /api/account/studio/campaigns`,
 * the list the Studio's own Projects screen reads).
 *
 *   When    the first time the sub-nav shows on the Studio page, each time
 *           the Studio page is selected again, when the Studio says its list
 *           changed (components/studio/studio-changes.ts: a video or a Studio
 *           project made, renamed, moved or archived), and when another video
 *           opens in it (one made by a recording or by the agent, or a rename
 *           of the one left). Never on a timer.
 *   Kept    per workspace for the session, so a visit again lists it at once,
 *           the read refreshing it behind (no empty list, no flash).
 *   One     one read at a time per workspace; one asked for meanwhile runs
 *           once after it.
 *
 * A read the server refuses (a guest, the Studio off here) keeps what was
 * there: the sub-nav keeps its headings.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { CampaignSummary } from '@/lib/studio/engine/api'
import { STUDIO_API } from '@/components/studio/studio-env'

const lists = new Map<string, readonly CampaignSummary[]>()
const reading = new Map<string, Promise<void>>()
const again = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The list last read for a workspace; null: none yet. */
export function studioList(workspaceId: string | null): readonly CampaignSummary[] | null {
  return workspaceId ? (lists.get(workspaceId) ?? null) : null
}

/** Read a workspace's list (again). One at a time; one asked for meanwhile runs once after it. */
export function readStudioList(workspaceId: string): Promise<void> {
  const busy = reading.get(workspaceId)
  if (busy) {
    again.add(workspaceId)
    return busy
  }
  const read = (async () => {
    try {
      const res = await fetch(`${STUDIO_API}/campaigns`)
      if (!res.ok) return
      const data = (await res.json()) as { campaigns?: unknown }
      if (!Array.isArray(data.campaigns)) return
      lists.set(workspaceId, data.campaigns as CampaignSummary[])
      notify()
    } catch {
      // Offline or the server away: what was there stays.
    } finally {
      reading.delete(workspaceId)
      if (again.delete(workspaceId)) void readStudioList(workspaceId)
    }
  })()
  reading.set(workspaceId, read)
  return read
}

/**
 * The workspace's list for the sub-nav, read while `active` (its page
 * selected) as the header says: at once from what was kept, then fresh.
 */
export function useStudioList(
  workspaceId: string | null,
  active: boolean,
  revision: number,
  openVideoId: string | null,
): readonly CampaignSummary[] | null {
  const list = useSyncExternalStore(
    subscribe,
    () => studioList(workspaceId),
    () => null,
  )
  useEffect(() => {
    if (active && workspaceId) void readStudioList(workspaceId)
  }, [active, workspaceId, revision, openVideoId])
  return list
}

/** Tests: nothing kept. */
export function __resetStudioListsForTests(): void {
  lists.clear()
  reading.clear()
  again.clear()
}
