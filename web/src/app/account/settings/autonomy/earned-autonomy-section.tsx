'use client'

/**
 * Settings › Autonomy: "What the agent has earned" (docs/plans/earned-autonomy.md
 * §6). Read-only in phase 1: each kind of work the person has a record for, its
 * level, its record, and what it still needs (or why it always asks). Nothing
 * here changes what runs. Shown only while EARNED_AUTONOMY is on (the route
 * says `enabled`); off, it renders nothing.
 */
import { useEffect, useState } from 'react'
import type { KindSummary } from '@/lib/autonomy/records'
import { LEVEL_WORDS, needsLine, recordLine } from '@/lib/autonomy/lines'

export const EARNED_AUTONOMY_URL = '/api/account/autonomy/earned'

export function EarnedAutonomySection() {
  const [kinds, setKinds] = useState<KindSummary[] | null>(null)
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch(EARNED_AUTONOMY_URL, { cache: 'no-store' })
        if (!res.ok) return
        const body = (await res.json()) as { enabled?: boolean; kinds?: KindSummary[] }
        if (!live) return
        setEnabled(body.enabled === true)
        setKinds(Array.isArray(body.kinds) ? body.kinds : [])
      } catch {
        // The rest of the page works without it.
      }
    })()
    return () => {
      live = false
    }
  }, [])

  if (!enabled || !kinds) return null
  return (
    <section aria-label="What the agent has earned">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">What the agent has earned</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Your record with the agent, per kind of work. For now everything still waits for your yes; later the agent will
        offer to take over work you always approve, and only with your say-so.
      </p>
      {kinds.length === 0 ? (
        <p className="rounded-lg border px-4 py-3 text-xs text-muted-foreground">
          Nothing yet. As you approve or dismiss the agent’s cards, each kind of work shows up here.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {kinds.map((kind) => (
            <li key={kind.key} className="px-4 py-3">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{kind.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{LEVEL_WORDS[kind.level]}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{recordLine(kind)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{needsLine(kind)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
