'use client'

/**
 * A HUD button that acts on the mouse press, not the release (Liam, 10-20:
 * the first click on the HUD's controls, the one that brings the window
 * forward from the call app, often did nothing and had to be clicked again;
 * stopping a capture once took killing the app). The press reaches the page
 * (the button lights on hover, and the window takes the first mouse); the
 * release that would complete a click can be lost while the window comes
 * forward. So a left mouse press runs it at once, and the click that follows
 * it is skipped. A click with no mouse press before it (Enter or Space on a
 * focused button, a touch) still runs it, once.
 *
 * Returns the button's handlers; spread them on it in place of `onClick`.
 */
import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react'

export interface PressActionHandlers {
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void
  onClick: () => void
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
}

export function usePressAction(run: () => void): PressActionHandlers {
  const runRef = useRef(run)
  runRef.current = run
  // The last press was a left mouse press that already ran: its click is skipped.
  const pressed = useRef(false)
  return useMemo(
    () => ({
      onPointerDown: (e) => {
        pressed.current = e.pointerType === 'mouse' && e.button === 0 && !e.currentTarget.disabled
        if (pressed.current) runRef.current()
      },
      onClick: () => {
        if (pressed.current) {
          pressed.current = false
          return
        }
        runRef.current()
      },
      // A key press is never the click of an earlier mouse press (one whose click was lost).
      onKeyDown: () => {
        pressed.current = false
      },
    }),
    [],
  )
}
