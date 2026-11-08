'use client'

/**
 * The composer's mic picker (desktop only), after Claude desktop's: a small
 * chevron grouped with send's slot in one rounded outline, opening a popover
 * with a live input-level bar over the mics. Unlike Claude's, the list is the
 * desktop's input-device priority order, and this is the only place it is
 * managed.
 *
 * The group stays mounted, chevron and all, whatever the slot shows (send,
 * the voice-mode waveform, voice mode's stop square, Stop generating), and
 * the slot is a fixed 32 px square: starting dictation, typing or a reply
 * generating swaps only the slot's button, so nothing in the composer's row
 * moves (Liam, 2026-09-26). The chevron stays usable while dictating too.
 *
 *  - Every mic the Mac has seen, highest first. When the order is customised
 *    the desktop records from the highest one that's connected (switching
 *    live mid-meeting); otherwise from the Mac's default. The active row has
 *    a blue check, pulsing while a stream captures on it; Bluetooth rows
 *    carry the call-quality hint.
 *  - One short header line (Liam, 2026-09-26: "much shorter"): "Drag to set
 *    priority · click to use now", or "Using <name> for now · Back to your
 *    order" while a mic is chosen for now.
 *  - Unplugged mics stay in their slot, greyed and labelled "Unavailable",
 *    still draggable, each with Forget (the X, or Delete on the row).
 *  - Only a move changes the order (Liam, 2026-09-26: a pick that jumped to
 *    the top lost the order he'd set). Drag by the grip (on hover or focus),
 *    inside a scrolling list that scrolls itself near its edges;
 *    Alt+ArrowUp / Alt+ArrowDown move the focused row one place; plain
 *    arrows, Home and End move focus. Each move is one setPriority with the
 *    full order.
 *  - Click a connected row (or Enter / Space) to use it FOR NOW: the desktop's
 *    override, never saved, and the check moves to it while the order stays.
 *    The header's "Back to your order", or clicking the row the order would
 *    pick, ends it (so do
 *    unplugging it and quitting Native Intelligence, on the desktop's side). Clicking an
 *    unplugged row does nothing. On a desktop without the override command a
 *    click moves the row to #1, as before.
 *  - No reset button (Liam, 2026-09-26): the order is just dragged. A one-time
 *    note the first time a Bluetooth mic comes into use, by a click or by
 *    reaching #1.
 *
 * Renders only its children (send's slot) until the device list has loaded,
 * and forever on a desktop without it (0.2.45) or in the browser.
 *
 * The popover's body below the level bar (the header, the list, the note) is
 * mic-picker-panel.tsx, fetched on demand: it brings framer-motion, and this
 * file is on the dashboard's first-load path (see the shell's heavy-deps
 * test). The pointer reaching the chevron, or focus on it, fetches it, so it
 * is usually here before the popover opens; until it is, a placeholder the
 * same size as the list stands in.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { UseInputDevices } from '@/hooks/use-input-devices'
import type { VoiceLiveStore } from '@/hooks/use-voice-mode'
import { MicLevelMeter } from './mic-level-meter'
import type { MicPickerPanelProps } from './mic-picker-panel'

// ── The panel, fetched on demand ─────────────────────────────────────────────

let loadedPanel: ComponentType<MicPickerPanelProps> | undefined
let pendingPanel: Promise<ComponentType<MicPickerPanelProps>> | undefined

/**
 * Fetch the popover's body once. A failed fetch is forgotten, so the next
 * hover, focus or open retries it. Not React.lazy (see lib/lazy-component):
 * a lazy component suspends on its first render even when its module is
 * already here, and React throttles that boundary's reveal by up to 300 ms,
 * which would undo the prefetch.
 */
export function preloadMicPickerPanel(): Promise<ComponentType<MicPickerPanelProps>> {
  pendingPanel ??= import('./mic-picker-panel').then(
    (m) => (loadedPanel = m.MicPickerPanel),
    (error: unknown) => {
      pendingPanel = undefined
      throw error
    },
  )
  return pendingPanel
}

const prefetchPanel = () => {
  preloadMicPickerPanel().catch(() => {})
}

/** Tests only: forget the fetched panel, as on a fresh load. */
export function __resetMicPickerPanelForTests() {
  loadedPanel = undefined
  pendingPanel = undefined
}

/** Tests only: whether the panel has been asked for. */
export function __micPickerPanelRequestedForTests(): boolean {
  return pendingPanel !== undefined
}

/** Stands in for the panel while it loads: the header line and one row per
 *  mic, at their sizes, so the popover opens at its final size. */
function MicPickerPanelPlaceholder({ count }: { count: number }) {
  const widths = ['w-40', 'w-28', 'w-44', 'w-32']
  return (
    <div aria-busy="true" data-testid="mic-picker-loading">
      <span className="sr-only">Loading microphones</span>
      <div className="px-2.5 pb-1.5">
        <div className="flex h-4 items-center">
          <div className="h-2.5 w-48 rounded-full bg-muted" />
        </div>
      </div>
      {count === 0 ? (
        <div className="h-8" />
      ) : (
        <div className="max-h-[min(18rem,45vh)] space-y-0.5 overflow-hidden">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} data-testid="mic-picker-loading-row" className="flex h-9 items-center pl-5 pr-2">
              <div className={`h-3 rounded-full bg-muted ${widths[i % widths.length]}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Radix's pick for the popover's autofocus, among what the panel renders. */
const TABBABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function LazyMicPickerPanel({
  contentRef,
  ...props
}: MicPickerPanelProps & { contentRef: RefObject<HTMLDivElement | null> }) {
  // Read once at mount: a panel that is already here renders in this commit.
  const [Panel, setPanel] = useState(() => loadedPanel)
  const arrivedLate = useRef(!Panel)

  useEffect(() => {
    if (Panel) {
      if (!arrivedLate.current) return
      arrivedLate.current = false
      // Opened from the keyboard before it arrived: the popover focused itself
      // (nothing in the placeholder takes focus), so move into the panel as
      // its autofocus would have. Opened with the pointer, focus stayed on the
      // chevron and stays there.
      const content = contentRef.current
      if (content && document.activeElement === content) content.querySelector<HTMLElement>(TABBABLE)?.focus()
      return
    }
    let live = true
    preloadMicPickerPanel().then(
      (component) => {
        // Wrapped: a bare function passed to a state setter is an updater.
        if (live) setPanel(() => component)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [Panel, contentRef])

  return Panel ? <Panel {...props} /> : <MicPickerPanelPlaceholder count={props.snapshot.devices.length} />
}

// ── The group: send's slot + the chevron ─────────────────────────────────────

export function MicPicker({
  devices,
  isActive,
  busy,
  voiceLive,
  quiet = false,
  children,
}: {
  devices: UseInputDevices
  /** The composer's tab is the active one (the popover closes otherwise). */
  isActive: boolean
  /** Dictation, a capture recording or Voice ID holds the mic. */
  busy: boolean
  /** Voice mode's live store while it runs in this panel (drives the bar). */
  voiceLive: VoiceLiveStore | null
  /**
   * The slot shows voice mode's plain waveform (not send or stop): hovering
   * the pair draws a hairline rounded outline round it (Claude's composer).
   */
  quiet?: boolean
  /** Send's slot: send, the waveform, or a stop square (all h-8 w-8). */
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Opened with the pointer: focus stays put (no ring on the first row), as
  // the composer's other pickers do. From the keyboard: into the list.
  const openedByPointerRef = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const { status, snapshot, setPriority, setOverride, forget, setDragging } = devices

  useEffect(() => {
    if (!isActive) setOpen(false)
  }, [isActive])

  const onChevronPointerDown = useCallback(() => {
    openedByPointerRef.current = true
    prefetchPanel()
  }, [])

  if (status !== 'ready' || !snapshot) return <>{children}</>

  // Clicks and presses on the chevron and in the (portalled) popover bubble
  // through the React tree to the composer, which would focus its field and
  // so close the popover.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

  const active = snapshot.devices.find((d) => d.active && d.available) ?? null
  const desktopLive = snapshot.devices.some((d) => d.live)

  return (
    <div
      role="group"
      aria-label="Voice and microphone"
      data-mic-picker
      // No pill round the pair at rest (Liam, 2026-10-09): the slot and a
      // small muted chevron. With the waveform in the slot (quiet), a hover
      // draws a hairline outline round both; a ring, so nothing moves.
      // The hover rides `data-quiet`, so the group's classes never change
      // with the slot (the row holds still).
      data-quiet={quiet ? '' : undefined}
      className="group/mic flex shrink-0 items-center rounded-[15px] transition-shadow duration-150 motion-reduce:transition-none data-[quiet]:hover:ring-1 data-[quiet]:hover:ring-border"
    >
      {/* A fixed square: what it shows changes, its footprint never does. */}
      <span data-testid="mic-picker-slot" className="flex h-8 w-8 shrink-0 items-center justify-center">
        {children}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Choose microphone"
            data-testid="mic-picker-chevron"
            data-mic-chevron=""
            onClick={stop}
            onPointerEnter={prefetchPanel}
            onFocus={prefetchPanel}
            onPointerDown={onChevronPointerDown}
            onKeyDown={() => {
              openedByPointerRef.current = false
            }}
            className="flex h-8 w-6 items-center justify-center rounded-[10px] pr-0.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none data-[state=open]:bg-muted data-[state=open]:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          side="top"
          align="end"
          sideOffset={8}
          className="w-80 p-2"
          data-testid="mic-picker"
          onOpenAutoFocus={(e) => {
            if (openedByPointerRef.current) e.preventDefault()
            openedByPointerRef.current = false
          }}
          onClick={stop}
          onMouseDown={stop}
        >
          <MicLevelMeter deviceName={active?.name ?? null} busy={busy || desktopLive} voiceLive={voiceLive} />
          <LazyMicPickerPanel
            contentRef={contentRef}
            snapshot={snapshot}
            setPriority={setPriority}
            setOverride={setOverride}
            forget={forget}
            setDragging={setDragging}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
