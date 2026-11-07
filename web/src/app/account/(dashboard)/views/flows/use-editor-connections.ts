'use client'

/**
 * The person's connected apps, as the Flows editor shows them for a
 * connected-app step (F4): each app, and the tools they let the agent see
 * (P5's allow-list and switches, tool-access.ts). Fetched once per mount, and
 * only when `enabled` (a loop with no connected-app step asks for nothing).
 */
import { useEffect, useState } from 'react'
import { visibleMcpTools, type McpToolLists } from '@/lib/mcp-client/tool-access'

export interface EditorConnection {
  id: string
  display_name: string
  is_enabled: boolean
  tools: string[]
}

export function useEditorConnections(enabled = true): EditorConnection[] | null {
  const [connections, setConnections] = useState<EditorConnection[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    fetch('/api/account/mcp-servers')
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((body: { servers?: Array<Record<string, unknown>> }) => {
        if (!live) return
        setConnections(
          (body.servers ?? []).map((s) => ({
            id: String(s.id),
            display_name: String(s.display_name ?? 'App'),
            is_enabled: s.is_enabled !== false,
            tools: visibleMcpTools(s as McpToolLists, (s.tools_cache as Array<{ name: string }> | null) ?? []).map((t) => t.name),
          })),
        )
      })
      .catch(() => {
        if (live) setConnections([])
      })
    return () => {
      live = false
    }
  }, [enabled])
  return connections
}
