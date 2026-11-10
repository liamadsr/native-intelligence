/**
 * Whether this Native Intelligence window is the one the user is in: the OS focus. The
 * desktop app can have several windows (a workspace each), sharing one voice;
 * listen mode follows the user from one to another
 * (components/read-aloud/listen-target.tsx). Leaving Native Intelligence for another app
 * changes nothing else: listening on while working elsewhere is the point.
 *
 * A module store: the window's focus and blur events are bound the first
 * time anything subscribes.
 */

import { useSyncExternalStore } from 'react'

let focused = true
let bound = false
const listeners = new Set<() => void>()

function read(): boolean {
  return typeof document === 'undefined' || document.hasFocus()
}

function onChange() {
  const next = read()
  if (next === focused) return
  focused = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  if (!bound && typeof window !== 'undefined') {
    bound = true
    focused = read()
    window.addEventListener('focus', onChange)
    window.addEventListener('blur', onChange)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether this window has the OS focus, live. */
export function useAppFocused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => focused,
    () => true,
  )
}

/** Tests only: forget the bound listeners and read the focus afresh. */
export function __resetAppFocusForTests(): void {
  if (bound && typeof window !== 'undefined') {
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
  }
  bound = false
  focused = true
  listeners.clear()
}
