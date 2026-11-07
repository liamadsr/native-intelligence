'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'

// ── Types ──────────────────────────────────────────────────

export interface HotkeyDefinition {
  /** Key to match (e.g. 'k', 'n', 'Escape', '/') — case-insensitive */
  key: string
  /** Require Cmd (Mac) / Ctrl (Win) */
  mod?: boolean
  /** Require Shift */
  shift?: boolean
  /** Require Alt/Option */
  alt?: boolean
  /** Handler to call when the hotkey fires */
  handler: (e: KeyboardEvent) => void
  /** If true, the hotkey fires even when an input/textarea/contentEditable is focused.
   *  Default: false (skip editable fields) */
  allowInInput?: boolean
  /** If true, e.preventDefault() is called automatically. Default: true */
  preventDefault?: boolean
  /** If true, the hotkey is currently disabled. Default: false */
  disabled?: boolean
}

// ── Utilities ──────────────────────────────────────────────

function isEditableTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  if (t instanceof HTMLInputElement) return true
  if (t instanceof HTMLTextAreaElement) return true
  if (t.isContentEditable) return true
  return false
}

/**
 * A bare printable key typed in an open menu or list (role="menu" or
 * "listbox": every Radix menu, select and combobox list) is that list's
 * typeahead, picking an item there; it isn't a shortcut as well. Only bare
 * keys: ⌘K, Escape and the arrows still reach their handlers.
 */
export function isListTypeahead(e: KeyboardEvent): boolean {
  if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return false
  const t = e.target
  return t instanceof Element && t.closest('[role="menu"],[role="listbox"]') !== null
}

function matchesHotkey(e: KeyboardEvent, def: HotkeyDefinition): boolean {
  // Modifier checks
  const wantMod = def.mod ?? false
  const hasMod = e.metaKey || e.ctrlKey
  if (wantMod !== hasMod) return false

  const wantShift = def.shift ?? false
  if (wantShift !== e.shiftKey) return false

  const wantAlt = def.alt ?? false
  if (wantAlt !== e.altKey) return false

  // Key check (case-insensitive)
  return e.key.toLowerCase() === def.key.toLowerCase()
}

// ── Hook: useHotkeys ───────────────────────────────────────
// Register multiple hotkeys at once. More efficient than multiple useHotkey
// calls since it uses a single event listener.

export function useHotkeys(defs: HotkeyDefinition[]) {
  const defsRef = useRef(defs)
  defsRef.current = defs

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (isListTypeahead(e)) return
      const editable = isEditableTarget(e)
      for (const d of defsRef.current) {
        if (d.disabled) continue
        if (!d.allowInInput && editable) continue
        if (!matchesHotkey(e, d)) continue
        if (d.preventDefault !== false) e.preventDefault()
        d.handler(e)
        return // Only fire the first match
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])
}

// ── Helpers for tooltip display ────────────────────────────

/**
 * True on a Mac: any browser on a Mac, or the Mac app. There `mod` reads as ⌘;
 * everywhere else (a Windows or Linux browser, the Windows app) as Ctrl. The
 * handlers accept either key, so this only decides what a label says.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /Mac|iPhone|iPad|iPod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent)
}

/**
 * A `mod` shortcut's label: modKeyLabel('K') is "⌘K" on a Mac and "Ctrl+K"
 * elsewhere; modKeyLabel() is "⌘" or "Ctrl". It reads the platform, so render
 * labels through {@link useModKeyLabel}.
 */
export function modKeyLabel(key = '', mac: boolean = isMacPlatform()): string {
  if (mac) return `⌘${key}`
  return key ? `Ctrl+${key}` : 'Ctrl'
}

const subscribeNoop = () => () => {}

/**
 * {@link modKeyLabel}, hydration-safe: the Mac label on the server and the
 * first client render, the person's platform after.
 */
export function useModKeyLabel(key = ''): string {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false)
  return modKeyLabel(key, mounted ? isMacPlatform() : true)
}

/** Format a hotkey definition for display (e.g. "⌘K", "C", "⌥⇧N") */
function formatHotkey(def: Pick<HotkeyDefinition, 'key' | 'mod' | 'shift' | 'alt'>): string {
  const isMac = isMacPlatform()
  const parts: string[] = []
  if (def.mod) parts.push(isMac ? '⌘' : 'Ctrl+')
  if (def.alt) parts.push(isMac ? '⌥' : 'Alt+')
  if (def.shift) parts.push(isMac ? '⇧' : 'Shift+')
  parts.push(def.key.toUpperCase())
  return parts.join('')
}
