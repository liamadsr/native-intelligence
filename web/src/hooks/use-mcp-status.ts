'use client'

import { useEffect, useState } from 'react'

/**
 * Shared MCP connection status. Fetches /api/mcp/oauth/clients and caches the
 * derived status so the pill doesn't flash on every mount. Re-fetches on
 * window focus so the indicator updates after authenticating in another tab.
 */

export type McpStatus = 'connected' | 'disconnected' | 'loading'

interface ClientRow {
  token_id: string
  is_expired: boolean
}

let cache: McpStatus = 'loading'
let lastFetchedAt = 0
let inFlight: Promise<void> | null = null
const listeners = new Set<(status: McpStatus) => void>()

const STALE_MS = 30_000 // re-fetch if older than 30 s

function notify() {
  listeners.forEach((fn) => fn(cache))
}

function computeStatus(clients: ClientRow[]): McpStatus {
  if (!clients || clients.length === 0) return 'disconnected'
  const hasHealthy = clients.some((c) => !c.is_expired)
  return hasHealthy ? 'connected' : 'disconnected'
}

function fetchStatus() {
  if (inFlight) return
  inFlight = fetch('/api/mcp/oauth/clients')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      cache = computeStatus(data?.clients || [])
      lastFetchedAt = Date.now()
      notify()
    })
    .catch(() => {
      cache = 'disconnected'
      lastFetchedAt = Date.now()
      notify()
    })
    .finally(() => {
      inFlight = null
    })
}

function ensureFetched() {
  if (cache === 'loading' || Date.now() - lastFetchedAt > STALE_MS) {
    fetchStatus()
  }
}

export function useMcpStatus(): McpStatus {
  const [status, setStatus] = useState<McpStatus>(cache)

  useEffect(() => {
    listeners.add(setStatus)
    ensureFetched()

    const onFocus = () => ensureFetched()
    window.addEventListener('focus', onFocus)

    return () => {
      listeners.delete(setStatus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return status
}
