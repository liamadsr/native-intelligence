'use client'

/**
 * A Create-dialog entry whose making needs its own page (a multi-step setup:
 * an agent's editor, the sequence builder…) opens that page and, on it, its
 * own create flow, rather than a copy of it in the dialog (Liam, 11-20).
 *
 * openPageCreate(kind, slug) opens the page as everything opens a page
 * (openTarget `page`) and leaves one request; the page's view takes it with
 * usePageCreate(kind, start): at once when it is already mounted (the event),
 * or when it mounts (the request left waiting). A request is taken once, and
 * goes stale after a few seconds, so a page opened much later by other means
 * never starts a create nobody asked for.
 */
import { useEffect, useRef } from 'react'
import { openTarget } from '@/lib/chat-cards/open-card'

export type PageCreateKind = 'agent' | 'skill' | 'sequence' | 'prospect_list' | 'campaign' | 'booking_link' | 'studio_video'

export const PAGE_CREATE_EVENT = 'ni:page-create'
const STALE_MS = 8000

let pending: { kind: PageCreateKind; at: number } | null = null

/** Take the waiting request for `kind`, if there is a fresh one. */
export function takePageCreate(kind: PageCreateKind, now = Date.now()): boolean {
  if (!pending || pending.kind !== kind) return false
  const fresh = now - pending.at <= STALE_MS
  pending = null
  return fresh
}

export function openPageCreate(kind: PageCreateKind, slug: string): boolean {
  pending = { kind, at: Date.now() }
  const opened = openTarget({ type: 'page', slug }, { from: 'create' })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PAGE_CREATE_EVENT, { detail: { kind } }))
  return opened
}

/** On a page's view: start its create flow when the Create dialog asks for `kind`. */
export function usePageCreate(kind: PageCreateKind, start: () => void): void {
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (takePageCreate(kind)) startRef.current()
    const onAsk = (e: Event) => {
      if ((e as CustomEvent<{ kind?: string }>).detail?.kind !== kind) return
      if (takePageCreate(kind)) startRef.current()
    }
    window.addEventListener(PAGE_CREATE_EVENT, onAsk)
    return () => window.removeEventListener(PAGE_CREATE_EVENT, onAsk)
  }, [kind])
}

export function __resetPageCreateForTests(): void {
  pending = null
}
