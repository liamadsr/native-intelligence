'use client'

/**
 * The Connections panel's data: OAuth statuses, connected MCP servers, Dial8's
 * Slack app and (on desktop) the local Exchange calendar, grouped by
 * `groupConnections`.
 *
 * Read on mount (so a needs-attention dot can show before the panel opens),
 * again each time the panel opens (`active` turns true), on window focus while
 * it's open (a desktop OAuth detour ends with the user switching back), and on
 * `refresh()` (call it from `useConnectProvider`'s `onReturn`). No polling: a
 * connection's state only changes through one of those moments.
 *
 * A failed read keeps the last good data silently; a stale response (an older
 * read finishing after a newer one started) is dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { desktopOS } from '@/lib/platform'
import type { LocalCalendarStatus } from '@/lib/tauri-bridge'
import { SUGGESTED_MCP_SERVERS } from '@/lib/mcp-client/suggested'
import { fetchOAuthStatus, type OAuthStatus } from './oauth-status'
import {
  groupConnections,
  needsAttention as groupsNeedAttention,
  type ConnectionGroups,
  type McpServerRow,
  type PhoneStatus,
  type SlackAppStatus,
} from './connections'

export interface UseConnections {
  groups: ConnectionGroups
  needsAttention: boolean
  /** True until the first read settles (either way). */
  loading: boolean
  refresh: () => void
}

async function fetchMcpServers(signal: AbortSignal): Promise<McpServerRow[] | null> {
  const res = await fetch('/api/account/mcp-servers', { signal })
  if (!res.ok) return null
  const json = (await res.json()) as { servers?: McpServerRow[] }
  return json.servers ?? []
}

async function fetchSlackApp(signal: AbortSignal): Promise<SlackAppStatus | null> {
  const res = await fetch('/api/account/integrations/slack', { signal })
  if (!res.ok) return null
  return (await res.json()) as SlackAppStatus
}

async function fetchPhone(signal: AbortSignal): Promise<PhoneStatus | null> {
  const res = await fetch('/api/account/phone', { signal })
  if (!res.ok) return null
  return (await res.json()) as PhoneStatus
}

async function readLocalExchange(): Promise<LocalCalendarStatus | null> {
  const { tauriBridge } = await import('@/lib/tauri-bridge')
  return tauriBridge.getLocalCalendarStatus()
}

export function useConnections({ active }: { active: boolean }): UseConnections {
  const [status, setStatus] = useState<OAuthStatus | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerRow[] | null>(null)
  const [slack, setSlack] = useState<SlackAppStatus | null>(null)
  const [phone, setPhone] = useState<PhoneStatus | null>(null)
  const [localExchange, setLocalExchange] = useState<LocalCalendarStatus | null>(null)
  const [desktop, setDesktop] = useState(false)
  const [loading, setLoading] = useState(true)

  /** Each read's number; only the newest may write. */
  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++seqRef.current
    const current = () => seq === seqRef.current
    // The local Exchange calendar reads macOS Calendar: the Mac app only. The
    // Windows app has no local calendar (its cloud Google/Microsoft ones cover it).
    const isDesktop = desktopOS() === 'macos'

    const reads: Promise<unknown>[] = [
      fetchOAuthStatus({ signal: controller.signal }).then((next) => {
        if (next && current()) setStatus(next)
      }),
      fetchMcpServers(controller.signal).then((next) => {
        if (next && current()) setMcpServers(next)
      }),
      fetchSlackApp(controller.signal).then((next) => {
        if (next && current()) setSlack(next)
      }),
      fetchPhone(controller.signal).then((next) => {
        if (next && current()) setPhone(next)
      }),
    ]
    if (isDesktop) {
      reads.push(
        readLocalExchange().then((next) => {
          if (next && current()) setLocalExchange(next)
        }),
      )
    }
    void Promise.allSettled(reads).then(() => {
      if (!current()) return
      setDesktop(isDesktop)
      setLoading(false)
      abortRef.current = null
    })
  }, [])

  /** Abort the read in flight and make sure nothing still running may write. */
  const invalidate = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    seqRef.current++
  }, [])

  // Mount.
  useEffect(() => {
    refresh()
    return invalidate
  }, [refresh, invalidate])

  // Every time the panel opens (not on mount: the read above covers it).
  const prevActiveRef = useRef(active)
  useEffect(() => {
    if (active && !prevActiveRef.current) refresh()
    prevActiveRef.current = active
  }, [active, refresh])

  // Focus re-reads only while the panel is open.
  useEffect(() => {
    if (!active) return
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, refresh])

  const groups = useMemo(
    () =>
      groupConnections({
        status,
        mcpServers,
        suggested: SUGGESTED_MCP_SERVERS,
        desktop,
        localExchange,
        slack,
        phone,
      }),
    [status, mcpServers, desktop, localExchange, slack, phone],
  )

  return { groups, needsAttention: groupsNeedAttention(groups), loading, refresh }
}
