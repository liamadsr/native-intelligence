'use client'

/**
 * A detail page's properties and its toolbar actions, in a popover behind the
 * Properties button of the frame the page is in: a card in the chat now
 * (chat-cards/card-body.tsx mounts the provider and puts the button in the
 * card's header), a floating window before. A card full screen, with room,
 * has them in a column on its right instead, always shown, and no button
 * (`embedded`: WindowPropertiesSidebar; Liam, 10-19: "if they're full screen
 * then you see it embedded on the right hand side"). Outside a frame (a page
 * drawn on its own) the properties are the page's own width-driven sidebar
 * again (usePropertiesVisible) and the actions sit in its header row.
 */
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { CARD_HEADER_ICON_BUTTON, CARD_HEADER_ICON_BUTTON_ACTIVE } from '@/components/chat-cards/card-header-button'
import { LiquidPopoverSurface } from '@/components/ui/liquid-popover-surface'
import { useLiquidPillHover } from '@/components/ui/liquid-pill'
import { SlidersHorizontal } from 'lucide-react'
import { PreferencesActionsContext } from './preference-action'
import {
  Activity,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

type PropertyEntry = {
  id: string
  title: string
  host: HTMLDivElement
  locked: boolean
}
type OpenState = { id: string; pinned: boolean } | null
type ActionsEntry = { id: string; host: HTMLDivElement }
/** What the frame tells the inspector: a card or a window in front, on screen, not folded away. */
export type PropertiesFrame = {
  isFocused: boolean
  tucked: boolean
  /** Full screen with room: the properties stand in a column on the frame's right (WindowPropertiesSidebar), open, and the header has no button. */
  embedded?: boolean
}
type PropertiesContextValue = {
  frame: PropertiesFrame | null
  entry: PropertyEntry | null
  actions: ActionsEntry | null
  open: boolean
  pinned: boolean
  register: (entry: PropertyEntry) => () => void
  registerActions: (entry: ActionsEntry) => () => void
  setOpen: (open: boolean, pinned?: boolean) => void
}

const PropertiesContext = createContext<PropertiesContextValue | null>(null)
const PropertiesAvailableContext = createContext(true)

/** Covered list pages stay alive beneath a detail overlay but must not publish
 * their inspector over the detail the user is actually viewing. */
export function PropertiesScope({
  available,
  children,
}: {
  available: boolean
  children: React.ReactNode
}) {
  const parentAvailable = useContext(PropertiesAvailableContext)
  return (
    <PropertiesAvailableContext.Provider value={available && parentAvailable}>
      {children}
    </PropertiesAvailableContext.Provider>
  )
}

/** Each frame (a card, a window) owns its inspector. The fields retain their
 * original React context while their DOM is hosted in the header’s popover. */
export function WindowPropertiesProvider({
  frame = null,
  children,
}: {
  frame?: PropertiesFrame | null
  children: React.ReactNode
}) {
  const [entry, setEntry] = useState<PropertyEntry | null>(null)
  const [actions, setActions] = useState<ActionsEntry | null>(null)
  const [state, setState] = useState<OpenState>(null)
  useEffect(() => setState(null), [entry?.id])
  useEffect(() => {
    if (frame?.isFocused === false || frame?.tucked) setState(null)
  }, [frame?.isFocused, frame?.tucked])
  const register = useCallback((next: PropertyEntry) => {
    setEntry(next)
    return () =>
      setEntry((current) => (current?.id === next.id ? null : current))
  }, [])
  const registerActions = useCallback((next: ActionsEntry) => {
    setActions(next)
    return () => setActions((current) => current?.id === next.id ? null : current)
  }, [])
  const locked = !!entry?.locked && (!frame || frame.isFocused)
  // Embedded, the column is always there: open and held, whatever the hover did.
  const embedded = !!frame?.embedded
  const open = !!entry && (embedded || locked || state?.id === entry.id)
  const pinned =
    !!entry && (embedded || locked || (state?.id === entry.id && state.pinned))
  const setOpen = useCallback(
    (next: boolean, pin = false) => {
      if (!entry) return
      setState((current) => {
        if (!next) return null
        return current?.id === entry.id && current.pinned === pin
          ? current
          : { id: entry.id, pinned: pin }
      })
    },
    [entry],
  )
  const value = useMemo(
    () => ({ frame, entry, actions, open, pinned, register, registerActions, setOpen }),
    [frame, entry, actions, open, pinned, register, registerActions, setOpen],
  )
  return (
    <PropertiesContext.Provider value={value}>
      {children}
    </PropertiesContext.Provider>
  )
}

/** Toolbar actions keep their original context and stay mounted while closed:
 * reminders and externally armed compose flows must still receive events. */
export function WindowActions({ children, className, reveal = false }: {
  children: React.ReactNode
  className?: string
  reveal?: boolean
}) {
  const context = useContext(PropertiesContext)
  const register = context?.registerActions
  const setOpen = context?.setOpen
  const frame = context?.frame ?? null
  const available = useContext(PropertiesAvailableContext)
  const active = available && (!frame || !frame.tucked)
  const id = useId()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (register) setHost(document.createElement('div'))
  }, [register])
  useLayoutEffect(() => {
    if (register && host && active) return register({ id, host })
  }, [register, host, active, id])
  useEffect(() => {
    if (reveal && active && frame?.isFocused !== false) setOpen?.(true, true)
  }, [reveal, active, frame?.isFocused, setOpen])

  if (!context) return <div className={className}>{children}</div>
  return host ? createPortal(
    <PreferencesActionsContext.Provider value>
      <div
        className="flex flex-col gap-0.5"
        data-preference-actions=""
        onPointerDownCapture={() => context.setOpen(true, true)}
        onFocusCapture={() => context.setOpen(true, true)}
      >
        {children}
      </div>
    </PreferencesActionsContext.Provider>,
    host,
  ) : null
}

/** Null outside a frame (a card), where standalone detail surfaces retain their
 * inline properties. Consumers can still defer expensive live-ticket reads. */
export function useWindowPropertiesVisible(): boolean | null {
  const context = useContext(PropertiesContext)
  const frame = context?.frame ?? null
  const available = useContext(PropertiesAvailableContext)
  if (!context) return null
  return (
    available &&
    context.open &&
    (!frame || !frame.tucked)
  )
}

export function WindowProperties({
  title,
  children,
  locked = false,
  available = true,
  fallbackVisible = true,
}: {
  title: string
  children: React.ReactNode
  locked?: boolean
  available?: boolean
  fallbackVisible?: boolean
}) {
  const context = useContext(PropertiesContext)
  const register = context?.register
  const frame = context?.frame ?? null
  const scopeAvailable = useContext(PropertiesAvailableContext)
  const id = useId()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const active =
    scopeAvailable &&
    available &&
    (!frame || !frame.tucked)

  useLayoutEffect(() => {
    if (register) setHost(document.createElement('div'))
  }, [register])
  useLayoutEffect(() => {
    if (!register || !host || !active) return
    return register({ id, title, host, locked })
  }, [register, host, active, id, title, locked])

  // Kept mounted even when the inspector is hidden: an unfinished input or
  // provider compose form must survive moving between windows and hovering out.
  if (!context)
    return fallbackVisible ? (
      <div className="h-full w-[289px] shrink-0 overflow-y-auto">
        {children}
      </div>
    ) : null
  return host
    ? createPortal(
        <Activity mode={active && context.open && context.entry?.id === id ? 'visible' : 'hidden'}>
          <div
            className="[&_[data-properties-heading]]:hidden"
            onPointerDownCapture={() => context.setOpen(true, true)}
            onFocusCapture={() => context.setOpen(true, true)}
          >
            {children}
          </div>
        </Activity>,
        host,
      )
    : null
}

/** A child picker is portalled by Radix outside our content DOM. Treat its
 * surface as part of the inspector for hover and outside-click dismissal. */
function isPickerSurface(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="listbox"]',
    )
  )
}

export function useHasWindowProperties() {
  const context = useContext(PropertiesContext)
  const available = useContext(PropertiesAvailableContext)
  return available && !!context?.entry
}

export function WindowPropertiesButton() {
  const context = useContext(PropertiesContext)
  const available = useContext(PropertiesAvailableContext)
  // Embedded, the properties are in the column on the right: no button.
  if (!available || !context?.entry || context.frame?.embedded) return null
  return <PropertiesControl key={context.entry.id} {...context} />
}

/**
 * The properties in a column on the frame's right, always shown, while the
 * frame is `embedded` (a card full screen, with room: card-body.tsx); nothing
 * otherwise, when they're behind the header's button instead. The same fields
 * and actions, moved here rather than drawn twice: the inspector's DOM lives
 * in one place at a time, keeping any half-typed input.
 */
/**
 * The embedded column is showing: the frame embeds it and the page has
 * properties to show (a list page has none, and keeps its full width).
 */
export function useWindowPropertiesSidebarShown(): boolean {
  const context = useContext(PropertiesContext)
  const available = useContext(PropertiesAvailableContext)
  return available && !!context?.entry && !!context.frame?.embedded
}

export function WindowPropertiesSidebar() {
  const context = useContext(PropertiesContext)
  const shown = useWindowPropertiesSidebarShown()
  if (!shown || !context?.entry) return null
  return (
    <aside
      key={context.entry.id}
      aria-label={`${context.entry.title} properties`}
      data-properties-sidebar=""
      // No divider from the page, nor between the fields and the actions; the
      // first field level with the page's title (Liam, 10-19).
      className="h-full w-80 shrink-0 overflow-y-auto overscroll-contain pt-12"
    >
      <PropertiesContent entry={context.entry} actions={context.actions} divided={false} />
    </aside>
  )
}

/**
 * The inspector's content, wherever it's shown: the page's fields (its
 * registered host, moved in) and, under them, its actions — set off by a rule
 * in the popover (`divided`), by space alone in the embedded column. `onMounted`
 * hears when the fields arrive (the popover focuses the first one when opened
 * from the keyboard).
 */
function PropertiesContent({
  entry,
  actions,
  onMounted,
  divided = true,
}: {
  entry: PropertyEntry
  actions: ActionsEntry | null
  onMounted?: (host: HTMLDivElement) => void
  divided?: boolean
}) {
  const mountProperties = useCallback(
    (node: HTMLDivElement | null) => {
      const host = entry.host
      if (!node) {
        host.remove()
        return
      }
      node.appendChild(host)
      onMounted?.(host)
    },
    [entry, onMounted],
  )
  const mountActions = useCallback((node: HTMLDivElement | null) => {
    if (!actions) return
    if (node) node.appendChild(actions.host)
    else actions.host.remove()
  }, [actions])
  return (
    <>
      <div ref={mountProperties} />
      {actions && (
        <div className={cn('mx-4 py-3', divided && 'border-t border-border')} role="group" aria-label="Actions">
          <div ref={mountActions} />
        </div>
      )}
    </>
  )
}

function PropertiesControl({
  entry,
  actions,
  open,
  pinned,
  setOpen,
}: PropertiesContextValue) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const keyboardOpen = useRef(false)
  const setHoverOpen = useCallback((next: boolean) => {
    if (!next && entry?.locked) return
    setOpen(next, next && pinned)
  }, [entry?.locked, pinned, setOpen])
  const { cancelClose, onPointerEnter } = useLiquidPillHover({
    open,
    setOpen: setHoverOpen,
    held: pinned,
    faceRef: triggerRef,
    // This is the stationary popover layout, not the bouncing liquid child.
    cardRef: contentRef,
    closeDelayMs: 400,
    hoverSlackPx: 16,
  })

  // Opened from the keyboard: the first field takes the focus as it arrives.
  const focusFirst = useCallback((host: HTMLDivElement) => {
    if (!keyboardOpen.current) return
    host
      .querySelector<HTMLElement>(
        'button:not(:disabled), input, [tabindex="0"]',
      )
      ?.focus()
    keyboardOpen.current = false
  }, [])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        cancelClose()
        setOpen(next, true)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label="Properties"
          title="Properties"
          className={cn(
            'relative flex size-7 shrink-0 items-center justify-center',
            CARD_HEADER_ICON_BUTTON,
            open && CARD_HEADER_ICON_BUTTON_ACTIVE,
          )}
          onPointerEnter={onPointerEnter}
          onClick={(event) => {
            if (open && !pinned) {
              event.preventDefault()
              cancelClose()
              setOpen(true, true)
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' ||
              event.key === ' ' ||
              event.key === 'ArrowDown'
            ) {
              event.preventDefault()
              keyboardOpen.current = true
              setOpen(true, true)
              if (open) {
                keyboardOpen.current = false
                entry?.host
                  .querySelector<HTMLElement>(
                    'button:not(:disabled), input, [tabindex="0"]',
                  )
                  ?.focus()
              }
            }
          }}
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        sideOffset={6}
        collisionPadding={12}
        // Hidden while its trigger is scrolled out of view (an inline card
        // under the composer), rather than following it there.
        hideWhenDetached
        aria-label={`${entry?.title ?? ''} properties`}
        className="w-80 max-w-[calc(100vw-24px)] overflow-visible rounded-3xl border-0 bg-transparent p-0 shadow-none data-[state=open]:animate-none motion-reduce:animate-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
        }}
        onPointerEnter={cancelClose}
        onPointerDownCapture={() => {
          cancelClose()
          setOpen(true, true)
        }}
        onFocusCapture={() => {
          cancelClose()
          setOpen(true, true)
        }}
        onInteractOutside={(event) => {
          if (entry?.locked || isPickerSurface(event.target))
            event.preventDefault()
          else setOpen(false)
        }}
        onEscapeKeyDown={(event) => {
          if (entry?.locked) {
            event.preventDefault()
            return
          }
          setOpen(false)
          triggerRef.current?.focus()
        }}
      >
        <LiquidPopoverSurface
          triggerRef={triggerRef}
          triggerIcon={<SlidersHorizontal className="size-3.5" />}
        >
          <div
            className="overflow-y-auto overscroll-contain rounded-3xl"
            style={{ maxHeight: 'min(680px, var(--radix-popover-content-available-height))' }}
          >
            {entry && <PropertiesContent entry={entry} actions={actions} onMounted={focusFirst} />}
          </div>
        </LiquidPopoverSurface>
      </PopoverContent>
    </Popover>
  )
}
