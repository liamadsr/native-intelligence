'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEntityListSync } from './use-entity-sync'

/**
 * Picker data for the attention rail's editable property pills — projects,
 * workspace members, and assignable AI team members — keyed BY WORKSPACE.
 *
 * The rail is a cross-workspace personal queue: every card carries its own
 * `workspace_id`, and PATCH /api/account/attention-items fences on THAT
 * workspace (re-verifying membership there, and validating every correction
 * against it) rather than on the active one. So a card from another workspace is
 * fully acceptable AND fully editable — it only ever lacked its own workspace's
 * lists to populate the pickers with. This hook is that missing half: one cached
 * set of lists per DISTINCT workspace present in the rail.
 *
 * Reaching another workspace needs no new API surface. The fetch interceptor
 * (lib/workspace-fetch.ts) only fills `x-workspace-id` in when the caller
 * HASN'T set it, and the server verifies membership on whatever header arrives —
 * so naming the workspace on the request is enough, and a workspace the user has
 * since left comes back refused rather than leaking.
 *
 * `/api/account/workspace` already returns workspace-wide members + aiMembers +
 * the workspace id in one shot; projects come from the minimal projects list.
 * Both are fetched LAZILY — only for a workspace that actually has a card — so
 * an empty rail still costs nothing, and a rail that never shows a foreign card
 * never touches a foreign workspace. Each workspace is fetched once and cached
 * for the hook's lifetime.
 *
 * Once loaded, the lists stay live: a project or member created anywhere (this
 * tab, a teammate, an MCP tool) re-fetches them via useEntityListSync. The bus
 * only ever carries events for the ACTIVE workspace (cross-tab envelopes whose
 * workspace doesn't match are dropped — see lib/entity-events.ts — and realtime
 * subscribes per workspace), and this hook deliberately doesn't track which
 * workspace that is, so a refetch refreshes every workspace it has cached. At
 * the handful of workspaces one rail can show that's cheaper than threading the
 * active id down here, and the active workspace keeps exactly the behaviour it
 * had. (AI team members still have no realtime source, so a newly-added agent
 * needs a reload to appear — unchanged.)
 */

export interface RailMember {
  id: string
  display_name: string
  avatar_url: string | null
}
export interface RailAiMember {
  id: string
  name: string
  avatar_url: string | null
}
export interface RailProject {
  id: string
  name: string
}

export interface RailPickerData {
  members: RailMember[]
  aiMembers: RailAiMember[]
  projects: RailProject[]
  /** The workspace these lists belong to — the cache key, echoed for callers. */
  workspaceId: string
  /** True only when the lists are REAL lists for `workspaceId`. A refused or
   *  failed workspace GET caches a not-loaded entry instead (see `load`), which
   *  keeps that card's pills read-only exactly as the single-workspace version
   *  did, without re-trying in a loop. */
  loaded: boolean
}

export interface RailPickerCache {
  /** This workspace's lists, or null while it hasn't been fetched yet. */
  get: (workspaceId: string) => RailPickerData | null
}

export function useRailPickerData(workspaceIds: string[]): RailPickerCache {
  const [cache, setCache] = useState<Record<string, RailPickerData>>({})

  // Workspaces whose first fetch has STARTED (not necessarily finished). Guards
  // the load effect against re-firing on every render and against two cards in
  // the same workspace racing each other. Entity-sync refetches deliberately
  // bypass it — they refresh what has already settled.
  const startedRef = useRef<Set<string>>(new Set())

  const load = useCallback(async (workspaceId: string) => {
    // Explicit header: the interceptor defers to a caller-set x-workspace-id, so
    // this pair reads the CARD's workspace even while another one is active.
    const headers = { 'x-workspace-id': workspaceId }
    try {
      const [wsRes, projRes] = await Promise.all([
        fetch('/api/account/workspace', { headers }),
        fetch('/api/account/projects?minimal=1', { headers }),
      ])

      const ws = wsRes.ok ? await wsRes.json() : {}
      const members: RailMember[] = (ws.members ?? []).map((m: RailMember) => ({
        id: m.id,
        display_name: m.display_name,
        avatar_url: m.avatar_url ?? null,
      }))
      const aiMembers: RailAiMember[] = (ws.aiMembers ?? []).map((a: RailAiMember) => ({
        id: a.id,
        name: a.name,
        avatar_url: a.avatar_url ?? null,
      }))
      const projects: RailProject[] = projRes.ok ? (await projRes.json()).projects ?? [] : []
      // The GET has to come back FOR the workspace we asked about before these
      // count as that workspace's lists — a refusal (no longer a member) or a
      // server that resolved some other workspace must not hand a card editable
      // pills full of the wrong workspace's people.
      const loaded = ws.workspace?.id === workspaceId

      setCache((c) => ({ ...c, [workspaceId]: { members, aiMembers, projects, workspaceId, loaded } }))
    } catch {
      // Network failure: cache a not-loaded entry so the card degrades to
      // read-only pills (accept/dismiss still work — the server owns those) and
      // the load effect doesn't retry this workspace every render.
      setCache((c) => ({
        ...c,
        [workspaceId]: c[workspaceId] ?? {
          members: [],
          aiMembers: [],
          projects: [],
          workspaceId,
          loaded: false,
        },
      }))
    }
  }, [])

  // Key by CONTENTS, not array identity: callers derive the id list inline from
  // `items`, so a fresh array arrives every render while the set of workspaces
  // rarely changes. Deriving the string on each render is cheaper than memoizing
  // it (the memo would need the same string as its own dep).
  const idsKey = Array.from(new Set(workspaceIds)).sort().join(',')

  // load() only calls setState after an awaited fetch (never synchronously), so
  // the cascading-render concern the rule guards against doesn't apply — this is
  // the documented "load from an external system" case. An empty rail yields an
  // empty key and fetches nothing.
  useEffect(() => {
    for (const ws of idsKey.split(',').filter(Boolean)) {
      if (startedRef.current.has(ws)) continue
      startedRef.current.add(ws)
      void load(ws)
    }
  }, [idsKey, load])

  // Keep the cached lists live once loaded: a project or member created/updated/
  // deleted anywhere re-fetches them (debounced 1s — pickers aren't latency-
  // sensitive). Iterating the CACHE (not startedRef) is the "first load has
  // settled" guard the single-workspace version kept in a ref: refetching a
  // workspace mid-flight would race its initial response.
  useEntityListSync(
    ['project', 'member'],
    () => {
      for (const ws of Object.keys(cache)) void load(ws)
    },
    // Live while anything is held, not only while a card names its workspace:
    // a card host mounted again later reads lists that kept up (bots-v4.md
    // Phase 3, AgentInfraHost holds this cache for the page).
    { debounceMs: 1000, enabled: idsKey.length > 0 || Object.keys(cache).length > 0 },
  )

  return useMemo<RailPickerCache>(
    () => ({ get: (workspaceId: string) => cache[workspaceId] ?? null }),
    [cache],
  )
}
