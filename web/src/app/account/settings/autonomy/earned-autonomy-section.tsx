'use client'

/**
 * Settings › Autonomy: "What the agent has earned" and "What I did on my own
 * today" (docs/plans/earned-autonomy.md §5, §6). Shown only while
 * EARNED_AUTONOMY is on (the route says `enabled`); off, it renders nothing.
 *
 * Under 'record' it is read-only: each kind, its level, its record and what it
 * still needs (or why it always asks). Under 'graduate' each row carries the
 * person's own decisions (Liam, 11-27, decision 1: their yes to "handle this
 * kind yourself" is their final yes; "Revoke stays available at any time"):
 * Hand it over (only where the server says it is earned), Not now, Always ask,
 * Revoke; and today's actions, each one still in its undo window with a Stop,
 * which dismisses its card (the Undo).
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { KindSummary } from '@/lib/autonomy/records'
import { LEVEL_WORDS, needsLine, recordLine } from '@/lib/autonomy/lines'
import type { KindDecision } from '@/lib/autonomy/decide'

export const EARNED_AUTONOMY_URL = '/api/account/autonomy/earned'
const ATTENTION_ITEMS_URL = '/api/account/attention-items'

interface ActionRow {
  id: string
  title: string | null
  status: 'scheduled' | 'running' | 'ran' | 'failed' | 'cancelled' | 'undone'
  run_at: string
  ran_at: string | null
  card_id: string | null
  reason: string | null
}

const STATUS_WORDS: Record<ActionRow['status'], string> = {
  scheduled: 'Going out shortly',
  running: 'Going out now',
  ran: 'Done',
  failed: 'Did not go through',
  cancelled: 'Sent back to you to approve',
  undone: 'You stopped it',
}

function time(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
}

export function EarnedAutonomySection() {
  const [kinds, setKinds] = useState<KindSummary[] | null>(null)
  const [actions, setActions] = useState<ActionRow[]>([])
  const [enabled, setEnabled] = useState(false)
  const [graduating, setGraduating] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(EARNED_AUTONOMY_URL, { cache: 'no-store' })
      if (!res.ok) return
      const body = (await res.json()) as { enabled?: boolean; mode?: string; kinds?: KindSummary[]; actions?: ActionRow[] }
      setEnabled(body.enabled === true)
      setGraduating(body.mode === 'graduate')
      setKinds(Array.isArray(body.kinds) ? body.kinds : [])
      setActions(Array.isArray(body.actions) ? body.actions : [])
    } catch {
      // The rest of the page works without it.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const decide = useCallback(
    async (kindKey: string, decision: KindDecision) => {
      setBusy(true)
      try {
        const res = await fetch(EARNED_AUTONOMY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind_key: kindKey, decision }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'Could not save')
        }
        if (decision === 'hand_over') toast('Handed over: the agent does these and tells you, with 5 minutes to stop each one')
        if (decision === 'revoke') toast('Taken back: these ask you first again')
        await load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save')
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const stop = useCallback(
    async (cardId: string) => {
      setBusy(true)
      try {
        const res = await fetch(ATTENTION_ITEMS_URL, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: cardId, action: 'dismiss' }),
        })
        if (!res.ok) throw new Error('Could not stop it')
        toast('Stopped. That kind asks you first again.')
        await load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not stop it')
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  if (!enabled || !kinds) return null
  return (
    <>
      <section aria-label="What the agent has earned">
        <h2 className="mb-1 text-sm font-medium text-muted-foreground">What the agent has earned</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {graduating
            ? 'Your record with the agent, per kind of work. When you always approve a kind, the agent offers to do it itself and tell you, with 5 minutes to stop each one. It only does that with your yes, and you can take it back here at any time.'
            : 'Your record with the agent, per kind of work. For now everything still waits for your yes.'}
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
                {graduating && !kind.alwaysAsks && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {kind.level !== 'ask' ? (
                      <button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void decide(kind.key, 'revoke')}>
                        Take it back
                      </button>
                    ) : kind.blocked === 'pinned' ? (
                      <button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void decide(kind.key, 'allow_offers')}>
                        Allow offers again
                      </button>
                    ) : kind.eligible === 'tell' ? (
                      <>
                        <button type="button" className="rounded border bg-foreground px-2 py-1 text-background" disabled={busy} onClick={() => void decide(kind.key, 'hand_over')}>
                          Hand it over
                        </button>
                        <button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void decide(kind.key, 'not_now')}>
                          Not now
                        </button>
                        <button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void decide(kind.key, 'never')}>
                          Always ask
                        </button>
                      </>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {graduating && (
        <section aria-label="What I did on my own today">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">What I did on my own today</h2>
          {actions.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-xs text-muted-foreground">Nothing on its own yet today.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {actions.map((a) => (
                <li key={a.id} className="flex items-baseline gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{a.title ?? 'An action'}</span>
                    <span className="block text-xs text-muted-foreground">
                      {STATUS_WORDS[a.status]} · {time(a.ran_at ?? a.run_at)}
                      {a.status === 'cancelled' && a.reason ? ` · ${a.reason}` : ''}
                    </span>
                  </span>
                  {a.status === 'scheduled' && a.card_id && (
                    <button type="button" className="shrink-0 rounded border px-2 py-1 text-xs" disabled={busy} onClick={() => void stop(a.card_id as string)}>
                      Stop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}
