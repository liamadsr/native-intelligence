/**
 * useFlowStatusIds — maps each workflow_state id to the enabled flows that fire
 * when an entity *enters* that status (the flow's trigger `to_status_id`).
 *
 * Powers the ⚡ indicators on status columns / chips: a board column or list
 * group "has a flow" iff any of the workflow_state ids merged into it is a key
 * in this map. Hovering names the flow(s); clicking opens the first one.
 *
 * Fetched once per workspace and cached in module scope (mirrors
 * use-picker-context.ts) so every status surface across views shares one fetch.
 * Revalidates when a `ni:entity-created` event fires for a flow, or on an
 * explicit `ni:flows-changed` event the flow editor emits after save/delete.
 */

'use client'

import * as React from 'react'

export interface FlowRef {
  id: string
  name: string
}

/** status_id → flows whose trigger lands on that status (enabled only). */
export type FlowStatusMap = Map<string, FlowRef[]>

interface FlowListItem {
  id: string
  name: string
  enabled: boolean
  trigger_type: string
  trigger_config: { to_status_id?: string } | null
}

// ── Module-level cache, keyed by workspace ─────────────────
const cache = new Map<string, Promise<FlowStatusMap>>()

function buildMap(flows: FlowListItem[]): FlowStatusMap {
  const map: FlowStatusMap = new Map()
  for (const f of flows) {
    // Only enabled status-change flows produce an indicator — a paused flow
    // won't fire, so showing ⚡ for it would be misleading.
    if (!f.enabled) continue
    if (f.trigger_type !== 'entity_status_change') continue
    const statusId = f.trigger_config?.to_status_id
    if (!statusId) continue
    const list = map.get(statusId)
    if (list) list.push({ id: f.id, name: f.name })
    else map.set(statusId, [{ id: f.id, name: f.name }])
  }
  return map
}

async function fetchFlowMap(): Promise<FlowStatusMap> {
  const res = await fetch('/api/account/flows')
  if (!res.ok) throw new Error(`flows fetch failed: ${res.status}`)
  const data = (await res.json()) as { flows?: FlowListItem[] }
  return buildMap(data.flows ?? [])
}

function getFlowMap(workspaceId: string): Promise<FlowStatusMap> {
  let p = cache.get(workspaceId)
  if (!p) {
    // On failure, evict the cache entry so a later mount retries instead of
    // serving a permanently-empty result. The caller still resolves to an
    // empty map (no indicators) for this attempt.
    p = fetchFlowMap().catch(() => {
      cache.delete(workspaceId)
      return new Map<string, FlowRef[]>()
    })
    cache.set(workspaceId, p)
  }
  return p
}

function invalidate(workspaceId: string | null) {
  if (workspaceId) cache.delete(workspaceId)
  else cache.clear()
}

/**
 * Returns the status→flows map for the workspace (empty until loaded). Pass
 * `null` while the workspace id is still resolving — the hook returns an empty
 * map and re-runs once a real id arrives.
 */
export function useFlowStatusIds(workspaceId: string | null): FlowStatusMap {
  const [map, setMap] = React.useState<FlowStatusMap>(() => new Map())

  React.useEffect(() => {
    if (!workspaceId) {
      setMap(new Map())
      return
    }
    let cancelled = false
    getFlowMap(workspaceId).then((m) => {
      if (!cancelled) setMap(m)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Revalidate when flows change (created via AI/dialog, or saved/deleted in
  // the canvas editor). Clear the cache and re-fetch so all status surfaces
  // pick up the new mapping without a reload.
  React.useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    const refresh = () => {
      invalidate(workspaceId)
      getFlowMap(workspaceId).then((m) => {
        if (!cancelled) setMap(m)
      })
    }
    const onCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { entityType?: string } | undefined
      if (detail?.entityType === 'flow') refresh()
    }
    window.addEventListener('ni:entity-created', onCreated)
    window.addEventListener('ni:flows-changed', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('ni:entity-created', onCreated)
      window.removeEventListener('ni:flows-changed', refresh)
    }
  }, [workspaceId])

  return map
}

/**
 * Union the enabled flows attached to a set of workflow_state ids, deduped by
 * flow id. A board column or list group merges every team's matching state, so
 * callers pass all of the column's member status ids and get back one flat,
 * deduplicated list. Order follows first-seen across the input ids.
 */
export function flowsForStatusIds(statusIds: string[], map: FlowStatusMap): FlowRef[] {
  if (map.size === 0 || statusIds.length === 0) return []
  const seen = new Set<string>()
  const out: FlowRef[] = []
  for (const id of statusIds) {
    for (const f of map.get(id) ?? []) {
      if (!seen.has(f.id)) {
        seen.add(f.id)
        out.push(f)
      }
    }
  }
  return out
}
