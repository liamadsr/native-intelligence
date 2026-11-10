'use client'

/**
 * Helpers for the desktop's input-device priority list, which lives in the
 * chat composer's mic picker (chat/mic-picker.tsx): the pure move helper, the
 * transport suffixes, and the Bluetooth hint and its one-time note.
 */

import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { InputDevice, InputTransport } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'

// ─── Pure helpers ──────────────────────────────────────────────

/** `list` with the item at `from` moved to `to` (both clamped). A new array;
 *  the input is untouched. Out-of-range `from` returns a copy. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice()
  if (from < 0 || from >= next.length) return next
  const target = Math.max(0, Math.min(next.length - 1, to))
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

// ─── Transports ────────────────────────────────────────────────

/** The short "(Built-in)" after a name; none for `other`, or when the name
 *  already says it ("iPhone Microphone" isn't followed by "(iPhone)"). */
const TRANSPORT_SUFFIXES: Record<InputTransport, string | null> = {
  builtIn: 'Built-in',
  bluetooth: 'Bluetooth',
  usb: 'USB',
  virtual: 'Virtual',
  aggregate: 'Aggregate',
  continuity: 'iPhone',
  display: 'Display',
  other: null,
}

export function transportSuffix(device: Pick<InputDevice, 'name' | 'transport'>): string | null {
  const suffix = TRANSPORT_SUFFIXES[device.transport]
  if (!suffix) return null
  return device.name.toLowerCase().includes(suffix.toLowerCase()) ? null : suffix
}

// ─── Bluetooth ─────────────────────────────────────────────────

export const BLUETOOTH_HINT =
  'Using this mic switches your AirPods or Bluetooth headphones to call quality while Native Intelligence is listening.'

/** Set once the one-time Bluetooth note has shown (a Bluetooth mic first
 *  moved to #1). */
export const BLUETOOTH_NOTE_KEY = 'ni.inputDevices.bluetoothNoteSeen'

export function hasSeenBluetoothNote(): boolean {
  try {
    return window.localStorage.getItem(BLUETOOTH_NOTE_KEY) === '1'
  } catch {
    return false
  }
}

export function markBluetoothNoteSeen(): void {
  try {
    window.localStorage.setItem(BLUETOOTH_NOTE_KEY, '1')
  } catch {
    /* storage blocked: the note may show again */
  }
}

/**
 * The info icon on a Bluetooth row, with BLUETOOTH_HINT in a tooltip on
 * hover. A plain icon, since it sits inside the row's button; the hint
 * belongs in that button's description for screen readers.
 */
export function BluetoothHint({
  className,
  testId = 'input-device-bluetooth-hint',
}: {
  className?: string
  testId?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden
          data-testid={testId}
          className={cn('shrink-0 text-muted-foreground/70 hover:text-muted-foreground', className)}
        >
          <Info className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{BLUETOOTH_HINT}</TooltipContent>
    </Tooltip>
  )
}
