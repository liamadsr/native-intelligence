'use client'

import { Liquid } from 'liquid-gooey'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { LIQUID_POPOVER_SURFACE } from './liquid-pill'

/** The pill's liquid pour inside a Radix-positioned portal. Radix still owns
 * collision handling, focus and nested pickers; the liquid paints its surface. */
export function LiquidPopoverSurface({
  triggerRef,
  triggerIcon,
  children,
}: {
  triggerRef: RefObject<HTMLElement | null>
  triggerIcon: ReactNode
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [origin, setOrigin] = useState({ x: 0, y: 0, width: 28, height: 28, cardWidth: 0, cardHeight: 0 })
  const [ready, setReady] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    if (expanded) return
    const root = rootRef.current
    const content = cardRef.current
    const trigger = triggerRef.current
    const positioner = root?.closest<HTMLElement>('[data-radix-popper-content-wrapper]')
    if (!root || !content || !trigger || !positioner) return

    // Start as soon as Radix has placed the portal, without an extra frame just
    // to read layout. Its offscreen measuring position is not an animation origin.
    const prepare = () => {
      if (!positioner.style.transform || positioner.style.transform.includes('-200%')) return
      // Like LiquidPillCard, measure the actual item at its unscaled size.
      // The enclosing group can include inline baseline space, and fields
      // restored from Activity may not have their final height on first mount.
      if (!content.offsetWidth || !content.offsetHeight) return
      const card = root.getBoundingClientRect()
      const face = trigger.getBoundingClientRect()
      const next = {
        x: face.left - card.left,
        y: face.top - card.top,
        width: face.width,
        height: face.height,
        cardWidth: content.offsetWidth,
        cardHeight: content.offsetHeight,
      }
      setOrigin((previous) => {
        return Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next])
          ? previous
          : next
      })
      setReady(true)
    }
    const observer = new MutationObserver(prepare)
    observer.observe(positioner, { attributes: true, attributeFilter: ['style'] })
    const resizeObserver = new ResizeObserver(prepare)
    resizeObserver.observe(content)
    prepare()
    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
    }
  }, [triggerRef, expanded])

  // Schedule the pour only AFTER React commits the measured, collapsed item.
  // Scheduling this alongside setOrigin in the observer lets React batch both
  // updates under load and spring from the initial card centre instead.
  useLayoutEffect(() => {
    if (!ready || expanded) return
    const frame = requestAnimationFrame(() => setExpanded(true))
    return () => cancelAnimationFrame(frame)
  }, [ready, origin, expanded])

  return (
    <Liquid
      ref={rootRef}
      {...LIQUID_POPOVER_SURFACE}
      // This group already fills the card. Unlike the tiny workspace pill, it
      // only needs room for the nearby icon and spring overshoot, not a second
      // full card's worth of padding on every edge of an expensive SVG filter.
      filterPadding={48}
      className="relative flex w-full flex-col [--background:0_0%_100%] dark:[--background:0_0%_0%]"
      data-liquid-popover=""
    >
      {ready && (
        <Liquid.Item className="pointer-events-none absolute" style={{ left: origin.x, top: origin.y }}>
          <div
            aria-hidden="true"
            className="text-muted-foreground flex items-center justify-center rounded-md"
            style={{ width: origin.width, height: origin.height }}
          >
            {triggerIcon}
          </div>
        </Liquid.Item>
      )}
      <Liquid.Item
        className="w-full"
        x={expanded ? 0 : origin.x + origin.width / 2 - origin.cardWidth / 2}
        y={expanded ? 0 : origin.y + origin.height / 2 - origin.cardHeight / 2}
        scale={expanded ? 1 : 0}
        // Park at the measured icon immediately; animating that invisible move
        // first made the reveal start partway between the icon and the panel.
        transition={expanded ? 'bouncy' : { duration: 0 }}
      >
        <div
          ref={cardRef}
          data-bot-obstacle
          className="rounded-3xl transition-opacity delay-100 duration-200 motion-reduce:delay-0 motion-reduce:transition-none"
          style={{ opacity: expanded ? 1 : 0 }}
        >
          {children}
        </div>
      </Liquid.Item>
    </Liquid>
  )
}
