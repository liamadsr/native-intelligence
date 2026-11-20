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
  /**
   * A two-key sequence's first key (`'g'` for "G then M"): the hotkey fires
   * only when `key` is pressed within {@link SEQUENCE_MS} of a bare `after`.
   * The first key itself does nothing else ({@link SEQUENCE_PREFIXES}).
   */
  after?: string
  /**
   * The app-wide shortcuts' guard (lib/shortcuts.ts): also skip while a
   * dialog, menu, popover or the palette owns the keyboard, or a modal is
   * open ({@link anotherLayerOwnsKeys}). Default: false (the older shortcuts
   * keep their own behaviour).
   */
  globalGuard?: boolean
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

/**
 * Does something in front own the keyboard: a modal (Radix locks the body's
 * scroll), or an open dialog, menu, listbox or popover (a tooltip doesn't
 * count), or is the key typed inside one? Then a bare app-wide shortcut stays
 * out of its way, as `/` does (chat-input.tsx isPaletteShortcutTarget).
 */
export function anotherLayerOwnsKeys(e: KeyboardEvent): boolean {
  if (typeof document === 'undefined') return false
  const t = e.target
  if (
    t instanceof Element &&
    t.closest('select, [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')
  ) {
    return true
  }
  if (document.body?.hasAttribute('data-scroll-locked')) return true
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [data-command-menu="palette"]')) return true
  for (const w of Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]'))) {
    if (!w.querySelector('[role="tooltip"]')) return true
  }
  return false
}

// ── Two-key sequences ("G then M") ─────────────────────────

/** How long after the first key the second still counts (Linear's feel: about a second). */
export const SEQUENCE_MS = 1500

/** The first keys of the registered sequences, lower case (only `g` today: lib/shortcuts.ts). */
export const SEQUENCE_PREFIXES = new Set<string>()

/** The sequence's first key pressed, and when; cleared by any other key. */
let pending: { key: string; at: number } | null = null
/** Per event, the prefix that was waiting when it was pressed (read by every useHotkeys listener for that one event). */
const armedFor = new WeakMap<KeyboardEvent, string | null>()
let sequenceListening = false

/** True when a bare key with no modifier, not repeated nor mid-IME, typed outside a text field. */
function isBareKey(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !e.isComposing && e.key.length === 1
}

/**
 * One window listener, in the capture phase (before every useHotkeys
 * listener on the document): notes which prefix this key completes, then
 * moves the sequence on: a bare prefix key arms it, anything else clears it.
 */
function onSequenceKey(e: KeyboardEvent): void {
  if (e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') return
  const now = Date.now()
  const waiting = pending && now - pending.at <= SEQUENCE_MS ? pending.key : null
  armedFor.set(e, waiting)
  const key = e.key.toLowerCase()
  if (!waiting && isBareKey(e) && !e.shiftKey && SEQUENCE_PREFIXES.has(key) && !isEditableTarget(e) && !isListTypeahead(e) && !anotherLayerOwnsKeys(e)) {
    pending = { key, at: now }
  } else {
    pending = null
  }
}

function listenForSequences(): void {
  if (sequenceListening || typeof window === 'undefined') return
  sequenceListening = true
  window.addEventListener('keydown', onSequenceKey, true)
}

/** The sequence prefix waiting when `e` was pressed (null: none). */
export function sequencePrefixOf(e: KeyboardEvent): string | null {
  return armedFor.get(e) ?? null
}

/** Is a sequence's first key waiting for its second (for a hint on screen)? */
export function sequencePending(): string | null {
  return pending && Date.now() - pending.at <= SEQUENCE_MS ? pending.key : null
}

/** Forget a waiting first key (tests; a page that takes the keyboard). */
export function resetSequence(): void {
  pending = null
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

  // A sequence's second key only right after its first, and a bare key never
  // as the second of one ("G then C" opens Calendar, not Create too).
  const armed = sequencePrefixOf(e)
  if (def.after ? armed !== def.after.toLowerCase() : armed !== null && !hasMod) return false

  // Key check (case-insensitive)
  return e.key.toLowerCase() === def.key.toLowerCase()
}

// ── Hook: useHotkeys ───────────────────────────────────────
// Register multiple hotkeys at once. More efficient than multiple useHotkey
// calls since it uses a single event listener.

export function useHotkeys(defs: HotkeyDefinition[]) {
  const defsRef = useRef(defs)
  defsRef.current = defs
  // A sequence's first key is known as one once a hotkey waits on it.
  for (const d of defs) if (d.after) SEQUENCE_PREFIXES.add(d.after.toLowerCase())

  useEffect(() => {
    listenForSequences()
    function handler(e: KeyboardEvent) {
      if (isListTypeahead(e)) return
      const editable = isEditableTarget(e)
      for (const d of defsRef.current) {
        if (d.disabled) continue
        if (!d.allowInInput && editable) continue
        if (d.globalGuard && (e.defaultPrevented || e.isComposing || anotherLayerOwnsKeys(e))) continue
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
export function formatHotkey(def: Pick<HotkeyDefinition, 'key' | 'mod' | 'shift' | 'alt'>): string {
  const isMac = isMacPlatform()
  const parts: string[] = []
  if (def.mod) parts.push(isMac ? '⌘' : 'Ctrl+')
  if (def.alt) parts.push(isMac ? '⌥' : 'Alt+')
  if (def.shift) parts.push(isMac ? '⇧' : 'Shift+')
  parts.push(def.key.toUpperCase())
  return parts.join('')
}
