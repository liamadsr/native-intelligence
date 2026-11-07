'use client'

/**
 * The mic picker's popover body, below the level bar: the header line, the
 * priority list (framer-motion's Reorder: drag by the grip, keyboard moves),
 * the one-time Bluetooth note and the announcer. The behaviour is described
 * in mic-picker.tsx.
 *
 * Its own module because framer-motion comes with it: mic-picker.tsx sits on
 * the dashboard's first-load path (via the composer) and fetches this file
 * the first time the pointer reaches the chevron, it takes focus, or the
 * popover opens (see the shell's heavy-deps test). Import it only through
 * `import()`.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { motion, Reorder, useDragControls } from 'framer-motion'
import { Bluetooth, Check, GripVertical, X } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  BLUETOOTH_HINT,
  BluetoothHint,
  hasSeenBluetoothNote,
  markBluetoothNoteSeen,
  moveItem,
  transportSuffix,
} from '@/components/desktop/input-device-shared'
import { priorityPick, type UseInputDevices } from '@/hooks/use-input-devices'
import type { InputDevice, InputDevicesSnapshot } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'

// ── One row ──────────────────────────────────────────────────────────────────

/** The name (and a muted transport suffix), truncated; the whole of it in a
 *  tooltip when it doesn't fit. */
function DeviceName({ device }: { device: InputDevice }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const suffix = transportSuffix(device)
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current
        setOpen(next && !!el && el.scrollWidth > el.clientWidth)
      }}
    >
      <TooltipTrigger asChild>
        <span ref={ref} className="min-w-0 truncate" data-testid="mic-picker-name">
          {device.name}
          {suffix && <span className="text-muted-foreground"> ({suffix})</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 break-words">
        {suffix ? `${device.name} (${suffix})` : device.name}
      </TooltipContent>
    </Tooltip>
  )
}

function PickerRow({
  device,
  index,
  describedBy,
  bluetoothHintId,
  onPick,
  onKeyDown,
  onForget,
  onDragStart,
  onDragEnd,
  buttonRef,
}: {
  device: InputDevice
  index: number
  describedBy: string
  bluetoothHintId: string
  onPick: (index: number) => void
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>, index: number) => void
  onForget: (device: InputDevice) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  buttonRef: (el: HTMLButtonElement | null) => void
}) {
  const controls = useDragControls()
  const bluetooth = device.transport === 'bluetooth'
  const unplugged = !device.available
  // Connected but deaf: a MacBook's mic with the lid shut. Greyed and not
  // pickable like an unplugged one, but nothing to forget.
  const lidClosed = !unplugged && device.unavailableReason === 'lid_closed'
  const unusable = unplugged || lidClosed
  return (
    <Reorder.Item
      as="li"
      value={device}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => onDragStart(device.id)}
      onDragEnd={onDragEnd}
      data-testid="mic-picker-row"
      data-device-id={device.id}
      data-available={device.available ? 'true' : 'false'}
      data-unavailable-reason={lidClosed ? 'lid_closed' : undefined}
      data-active={device.active ? 'true' : undefined}
      className={cn(
        'group relative flex items-center rounded-2xl bg-popover transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        !unusable && 'hover:bg-accent/60 has-[:focus-visible]:bg-accent/60',
      )}
    >
      {/* Pointer only: the row's button carries the keyboard moves. */}
      <span
        aria-hidden
        data-testid="mic-picker-grip"
        onPointerDown={(e) => {
          e.preventDefault()
          controls.start(e)
        }}
        className="flex h-9 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      <button
        ref={buttonRef}
        type="button"
        data-testid="mic-picker-pick"
        aria-describedby={bluetooth ? `${describedBy} ${bluetoothHintId}` : describedBy}
        aria-disabled={lidClosed ? true : undefined}
        onClick={() => onPick(index)}
        onKeyDown={(e) => onKeyDown(e, index)}
        className={cn(
          'flex h-9 min-w-0 flex-1 items-center gap-2 pr-2 text-left text-sm focus-visible:outline-none',
          unusable && 'cursor-default',
        )}
      >
        <span className={cn('flex min-w-0 items-center gap-2', unusable && 'opacity-50')}>
          <DeviceName device={device} />
          {bluetooth && <BluetoothHint testId="mic-picker-bluetooth-hint" />}
        </span>
        {device.active && <span className="sr-only">(in use)</span>}
        {unusable ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground" data-testid="mic-picker-unavailable">
            {lidClosed ? 'Unavailable · lid closed' : 'Unavailable'}
          </span>
        ) : (
          <span className="ml-auto flex w-4 shrink-0 justify-center">
            {device.active && (
              <Check
                aria-hidden
                data-testid="mic-picker-check"
                data-live={device.live ? 'true' : undefined}
                className={cn('h-4 w-4 text-blue-500 dark:text-blue-400', device.live && 'animate-pulse')}
              />
            )}
          </span>
        )}
      </button>
      {unplugged && (
        <button
          type="button"
          aria-label={`Forget ${device.name}`}
          title="Forget"
          data-testid="mic-picker-forget"
          onClick={() => onForget(device)}
          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </Reorder.Item>
  )
}

// ── The popover's body ───────────────────────────────────────────────────────

/** focusAfterRender target: the header line instead of a row. */
const FOCUS_HEADER = Symbol('header')

export interface MicPickerPanelProps {
  snapshot: InputDevicesSnapshot
  setPriority: UseInputDevices['setPriority']
  setOverride: UseInputDevices['setOverride']
  forget: UseInputDevices['forget']
  setDragging: UseInputDevices['setDragging']
}

export function MicPickerPanel({ snapshot, setPriority, setOverride, forget, setDragging }: MicPickerPanelProps) {
  const ids = useId()
  const helpId = `${ids}-help`
  const bluetoothHintId = `${ids}-bt`

  const devices = snapshot.devices
  // The order while a drag is in progress (framer reorders it per move); null
  // otherwise, when the snapshot's is shown.
  const [dragOrder, setDragOrder] = useState<InputDevice[] | null>(null)
  const dragOrderRef = useRef<InputDevice[] | null>(null)
  const draggedIdRef = useRef<string | null>(null)
  const rows = dragOrder ?? devices

  const [announcement, setAnnouncement] = useState('')
  const [showBluetoothNote, setShowBluetoothNote] = useState(false)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const headerRef = useRef<HTMLParagraphElement>(null)
  // Where focus goes once the next render lands: a row's button (by device
  // id) or the header line. Set before a change that re-orders the list or
  // unmounts the focused control (a keyboard move or pick, Forget).
  const focusAfterRender = useRef<string | typeof FOCUS_HEADER | null>(null)
  useEffect(() => {
    const target = focusAfterRender.current
    if (!target) return
    focusAfterRender.current = null
    const el = target === FOCUS_HEADER ? headerRef.current : buttons.current.get(target)
    if (el && document.activeElement !== el) el.focus()
  })

  /** The one-time note, when a Bluetooth mic comes into use. */
  const noteBluetooth = useCallback((device: InputDevice | undefined) => {
    if (device?.transport !== 'bluetooth' || hasSeenBluetoothNote()) return
    markBluetoothNoteSeen()
    setShowBluetoothNote(true)
  }, [])

  /** One write for a new order, plus the Bluetooth note on a move to #1. */
  const commit = useCallback(
    (next: InputDevice[]) => {
      const first = next[0]
      if (first && first.id !== devices[0]?.id) noteBluetooth(first)
      void setPriority(next.map((d) => d.id)).then((ok) => {
        if (!ok) toast.error("Couldn't save the microphone order")
      })
    },
    [devices, noteBluetooth, setPriority],
  )

  const orderPick = priorityPick(snapshot)
  const overrideDevice = snapshot.overrideId
    ? (devices.find((d) => d.id === snapshot.overrideId) ?? null)
    : null

  /** End the override: the order's pick is used again. */
  const backToOrder = useCallback(() => {
    setAnnouncement(orderPick ? `Back to your order: using ${orderPick.name}` : 'Back to your order')
    void setOverride(null).then((result) => {
      if (result === 'refused') toast.error("Couldn't go back to your microphone order")
    })
  }, [orderPick, setOverride])

  const pick = useCallback(
    (index: number) => {
      const device = devices[index]
      // Unplugged (Forget is beside it), or the lid shut: nothing to use.
      if (!device || !device.available || device.unavailableReason) return
      if (device.id === orderPick?.id) {
        // The order's own pick: ends an override, else it's already in use.
        if (overrideDevice) backToOrder()
        else setAnnouncement(`Using ${device.name}`)
        return
      }
      setAnnouncement(`Using ${device.name} for now`)
      if (device.id === overrideDevice?.id) return
      noteBluetooth(device)
      const fromKeyboard = document.activeElement === buttons.current.get(device.id)
      void setOverride(device.id).then((result) => {
        if (result === 'refused') {
          toast.error(`Couldn't switch to ${device.name}`)
        } else if (result === 'unsupported') {
          // A desktop without the override: move it to #1, as before.
          setAnnouncement(`Using ${device.name}`)
          if (index === 0) return
          // Keep keyboard focus on it as it moves to the top.
          if (fromKeyboard) focusAfterRender.current = device.id
          commit(moveItem(devices, index, 0))
        }
      })
    },
    [devices, orderPick, overrideDevice, backToOrder, noteBluetooth, setOverride, commit],
  )

  const handleForget = useCallback(
    (device: InputDevice) => {
      // The row unmounts: focus the next row, else the previous, else the header.
      const i = devices.findIndex((d) => d.id === device.id)
      const neighbour = i >= 0 ? (devices[i + 1] ?? devices[i - 1]) : undefined
      focusAfterRender.current = neighbour?.id ?? FOCUS_HEADER
      setAnnouncement(`${device.name} forgotten`)
      void forget(device.id).then((ok) => {
        if (!ok) toast.error(`Couldn't forget ${device.name}`)
      })
    },
    [devices, forget],
  )

  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = devices.length - 1
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const to = e.key === 'ArrowUp' ? index - 1 : index + 1
        if (to < 0 || to > last) return
        const next = moveItem(devices, index, to)
        const moved = next[to]
        focusAfterRender.current = moved.id
        setAnnouncement(`${moved.name} moved to ${to + 1} of ${next.length}`)
        commit(next)
        return
      }
      if (e.altKey || e.metaKey || e.ctrlKey) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const device = devices[index]
        if (device && !device.available) {
          e.preventDefault()
          handleForget(device)
        }
        return
      }
      const target =
        e.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : e.key === 'ArrowDown'
            ? Math.min(last, index + 1)
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? last
                : null
      if (target === null) return
      e.preventDefault()
      buttons.current.get(devices[target]?.id ?? '')?.focus()
    },
    [devices, commit, handleForget],
  )

  const handleReorder = useCallback((next: InputDevice[]) => {
    dragOrderRef.current = next
    setDragOrder(next)
  }, [])

  const handleDragStart = useCallback(
    (id: string) => {
      draggedIdRef.current = id
      setDragging(true)
      if (!dragOrderRef.current) {
        dragOrderRef.current = devices
        setDragOrder(devices)
      }
    },
    [setDragging, devices],
  )

  const handleDragEnd = useCallback(() => {
    const next = dragOrderRef.current
    const draggedId = draggedIdRef.current
    dragOrderRef.current = null
    draggedIdRef.current = null
    const changed = !!next && next.map((d) => d.id).join('\n') !== devices.map((d) => d.id).join('\n')
    // Write BEFORE releasing the hold, so an event held during the drag can't
    // flash the old order back in between.
    if (next && changed) {
      const to = next.findIndex((d) => d.id === draggedId)
      if (to >= 0) setAnnouncement(`${next[to].name} moved to ${to + 1} of ${next.length}`)
      commit(next)
    }
    setDragOrder(null)
    setDragging(false)
  }, [devices, commit, setDragging])

  return (
    <>
      <p
        ref={headerRef}
        tabIndex={-1}
        data-testid="mic-picker-header"
        data-override={overrideDevice ? 'true' : undefined}
        className={cn(
          'px-2.5 pb-1.5 text-xs text-muted-foreground focus-visible:outline-none',
          overrideDevice && 'flex items-baseline gap-1.5',
        )}
      >
        {overrideDevice ? (
          <>
            <span className="min-w-0 truncate" data-testid="mic-picker-override">
              Using {overrideDevice.name} for now
            </span>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <button
              type="button"
              data-testid="mic-picker-back-to-order"
              onClick={() => {
                // The button goes with the override: keep focus in the panel.
                focusAfterRender.current = FOCUS_HEADER
                backToOrder()
              }}
              className="shrink-0 rounded font-medium text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400"
            >
              Back to your order
            </button>
          </>
        ) : (
          'Drag to set priority · click to use now'
        )}
      </p>
      <p id={helpId} className="sr-only">
        Enter uses this microphone for now, without changing the order. Alt plus the up or down arrow moves it
        in the order. Delete forgets an unavailable one.
      </p>
      <p id={bluetoothHintId} className="sr-only">
        {BLUETOOTH_HINT}
      </p>
      {rows.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground" data-testid="mic-picker-empty">
          No microphones found.
        </p>
      ) : (
        // layoutScroll: framer measures the rows through this scroll offset,
        // and a drag near its edges scrolls it.
        <motion.div
          layoutScroll
          data-testid="mic-picker-scroll"
          className="max-h-[min(18rem,45vh)] overflow-y-auto overscroll-contain"
        >
          <TooltipProvider delayDuration={400}>
            <Reorder.Group
              as="ol"
              axis="y"
              values={rows}
              onReorder={handleReorder}
              aria-label="Microphones, in priority order"
              className="space-y-0.5"
            >
              {rows.map((d, i) => (
                <PickerRow
                  key={d.id}
                  device={d}
                  index={i}
                  describedBy={helpId}
                  bluetoothHintId={bluetoothHintId}
                  onPick={pick}
                  onKeyDown={onRowKeyDown}
                  onForget={handleForget}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  buttonRef={(el) => {
                    if (el) buttons.current.set(d.id, el)
                    else buttons.current.delete(d.id)
                  }}
                />
              ))}
            </Reorder.Group>
          </TooltipProvider>
        </motion.div>
      )}
      {showBluetoothNote && (
        <div
          className="mx-1 mt-1.5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="mic-picker-bluetooth-note"
        >
          <Bluetooth className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <p className="flex-1">{BLUETOOTH_HINT} For the best sound, use your built-in or a USB mic.</p>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setShowBluetoothNote(false)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div aria-live="polite" role="status" className="sr-only" data-testid="mic-picker-announcer">
        {announcement}
      </div>
    </>
  )
}
