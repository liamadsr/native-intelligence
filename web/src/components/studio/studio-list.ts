'use client'

/**
 * The Studio's list of Studio projects and their videos (`GET /api/account/studio/campaigns`, the list its
 * Projects and videos screen reads), kept for the Studio card (components/chat-cards/pages/studio-card.tsx): when
 * the person messages the agent with the Studio in front, the agent is told which Studio project the open video is
 * in (projectOfVideo), read from here at that moment, never fetched then.
 *
 *   When    the card reads it while it is open: once, then again when the Studio says its list changed
 *           (./studio-changes.ts: a video or a Studio project made, renamed, moved or archived) or another video
 *           opens. Never on a timer.
 *   Kept    per workspace for the session.
 *   One     one read at a time per workspace; one asked for meanwhile runs once after it.
 *
 * A read the server refuses (a guest, the Studio off here) keeps what was there.
 */
import type { CampaignSummary } from '@/lib/studio/engine/api'
import { STUDIO_API } from './studio-env'

const lists = new Map<string, readonly CampaignSummary[]>()
const reading = new Map<string, Promise<void>>()
const again = new Set<string>()

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
      if (Array.isArray(data.campaigns)) lists.set(workspaceId, data.campaigns as CampaignSummary[])
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

/** The Studio project (a real one, not the server's `single-` wrapper of a lone video) the video is in; null: none, or not listed. */
export function projectOfVideo(list: readonly CampaignSummary[], videoId: string): CampaignSummary | null {
  return list.find((c) => !c.single && c.ads.some((a) => a.id === videoId)) ?? null
}

/** Tests: nothing kept. */
export function __resetStudioListsForTests(): void {
  lists.clear()
  reading.clear()
  again.clear()
}
