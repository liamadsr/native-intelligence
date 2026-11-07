'use client'

/**
 * The live agent's name for the HUD's name tag: its agent row
 * (GET /api/account/agents/[id], the same read the main chat pins a live
 * conversation's persona with). Read once per agent per page; null until it
 * lands, for the built-in Assistant (no agent), or when it can't be read.
 */
import { useEffect, useState } from 'react'

const names = new Map<string, Promise<string | null>>()

function readName(agentId: string): Promise<string | null> {
  let read = names.get(agentId)
  if (!read) {
    read = fetch(`/api/account/agents/${encodeURIComponent(agentId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { agent?: { name?: unknown } } | null) => (typeof body?.agent?.name === 'string' ? body.agent.name : null))
      .catch(() => null)
    names.set(agentId, read)
    // A failed read is tried again next time.
    void read.then((name) => {
      if (name === null) names.delete(agentId)
    })
  }
  return read
}

export function useLiveAgentName(agentId: string | null): string | null {
  const [name, setName] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!agentId) return
    let live = true
    void readName(agentId).then((n) => {
      if (live) setName({ id: agentId, name: n })
    })
    return () => {
      live = false
    }
  }, [agentId])
  return agentId && name?.id === agentId ? name.name : null
}

/** Tests only: forget the names read. */
export function __resetLiveAgentNamesForTests(): void {
  names.clear()
}
