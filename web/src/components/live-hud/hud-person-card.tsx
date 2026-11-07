'use client'

/**
 * Who a voice on the call is (live sidekick plan, Phase 2): the HUD's
 * participant chip, once Voice ID has linked its speaker to a contact, opens
 * Voice ID's own card for it (VoiceIdSpeaker) with this person's lines added:
 * role · company, how they relate to the workspace, one line of background
 * (lib/crm/person-card.ts, GET /api/account/contacts/[id]/card).
 *
 * Never a guess: only a linked speaker gets one (a suggestion, an unknown
 * voice or a self prompt stays as it is). Each contact is fetched once per
 * call, when its chip is linked (so the card is ready by the time it's
 * opened), into a small store keyed by the call; a failed fetch is tried
 * again only when the card is next opened, a missing contact never. Nothing
 * to say (still loading, or a bare record): no lines at all.
 *
 * Each fetch names the call's workspace (Voice ID's state carries it) in its
 * own `x-workspace-id`, and the cache is keyed by it: the HUD window's first
 * chips can mount before it has pointed its requests at that workspace, and
 * a lookup in the last-saved one would 404 (and stay missing all call).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import type { PersonCard } from '@/lib/crm/person-card'

type Entry = { status: 'loading' } | { status: 'ready'; person: PersonCard } | { status: 'missing' } | { status: 'error' }

/** The call the cache holds people for: a new call starts it again. */
let cacheCall: string | null = null
const people = new Map<string, Entry>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of [...listeners]) listener()
}

function readPerson(raw: unknown): PersonCard | null {
  const p = (raw as { person?: unknown } | null)?.person as Record<string, unknown> | undefined
  if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') return null
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    id: p.id,
    name: p.name,
    role: text(p.role),
    company: text(p.company),
    relationship: text(p.relationship),
    background: text(p.background),
  }
}

const keyOf = (workspaceId: string | null, contactId: string) => `${workspaceId ?? ''}:${contactId}`

/**
 * Fetch `contactId`'s card in `workspaceId` for the call `captureId`, unless
 * it's had one (or is fetching it) this call. `retry` tries a failed fetch
 * again.
 */
export function loadHudPerson(
  captureId: string,
  workspaceId: string | null,
  contactId: string,
  { retry = false }: { retry?: boolean } = {},
): void {
  if (cacheCall !== captureId) {
    cacheCall = captureId
    people.clear()
  }
  const key = keyOf(workspaceId, contactId)
  const had = people.get(key)
  if (had && !(retry && had.status === 'error')) return
  people.set(key, { status: 'loading' })
  emit()
  const settle = (entry: Entry) => {
    if (cacheCall !== captureId || people.get(key)?.status !== 'loading') return
    people.set(key, entry)
    emit()
  }
  void fetch(
    `/api/account/contacts/${encodeURIComponent(contactId)}/card`,
    workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : undefined,
  )
    .then(async (res) => {
      if (res.status === 404) return settle({ status: 'missing' })
      if (!res.ok) return settle({ status: 'error' })
      const person = readPerson(await res.json().catch(() => null))
      settle(person ? { status: 'ready', person } : { status: 'error' })
    })
    .catch(() => settle({ status: 'error' }))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** `contactId`'s card this call, once it's in. */
export function useHudPerson(captureId: string, workspaceId: string | null, contactId: string): PersonCard | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const entry = cacheCall === captureId ? people.get(keyOf(workspaceId, contactId)) : undefined
      return entry?.status === 'ready' ? entry.person : null
    },
    () => null,
  )
}

export function __resetHudPeopleForTests(): void {
  cacheCall = null
  people.clear()
  listeners.clear()
}

/** Prefetch a linked speaker's card when its chip is linked (and for each newly linked contact). */
export function usePrefetchHudPerson(captureId: string, workspaceId: string | null, contactId: string | null): void {
  useEffect(() => {
    if (contactId) loadHudPerson(captureId, workspaceId, contactId)
  }, [captureId, workspaceId, contactId])
}

/** The person's lines inside Voice ID's card for a linked speaker. */
export function HudPersonCard({
  captureId,
  workspaceId,
  contactId,
}: {
  captureId: string
  workspaceId: string | null
  contactId: string
}) {
  // Opened: one more go at a fetch that failed.
  useEffect(() => loadHudPerson(captureId, workspaceId, contactId, { retry: true }), [captureId, workspaceId, contactId])
  const person = useHudPerson(captureId, workspaceId, contactId)
  if (!person) return null
  const role = [person.role, person.company].filter(Boolean).join(' · ')
  if (!role && !person.relationship && !person.background) return null
  return (
    <div data-hud-person={person.id} className="space-y-0.5 border-t border-border/40 px-3 py-2 text-[11px] leading-4">
      {role && (
        <p data-hud-person-role="" className="truncate font-medium text-foreground" title={role}>
          {role}
        </p>
      )}
      {person.relationship && (
        <p data-hud-person-relationship="" className={cn('truncate', BOT_GLASS_MUTED)}>
          {person.relationship}
        </p>
      )}
      {person.background && (
        <p data-hud-person-background="" className={cn('line-clamp-2', BOT_GLASS_MUTED)} title={person.background}>
          {person.background}
        </p>
      )}
    </div>
  )
}
