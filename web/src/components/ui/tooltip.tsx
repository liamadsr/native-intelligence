"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"
import { subscribePointerExit } from "@/lib/pointer-exit"

/**
 * Every tooltip in the app goes through these wrappers, so hover behaviour is
 * fixed here once rather than per call site.
 *
 * Two defaults differ from Radix's, both so a tooltip reliably goes away when
 * the pointer moves off its trigger (it used to stay up until the next click,
 * most visibly in the desktop app):
 *
 * 1. `disableHoverableContent` defaults to TRUE. Radix's default ("hoverable
 *    content") does NOT close on leaving the trigger: it draws a grace polygon
 *    toward the bubble and closes only when a LATER `pointermove` lands outside
 *    it. If no later move arrives — the pointer left the webview, went up into
 *    the macOS title-bar strip, or another window came over it — the tooltip
 *    never closes. Our tooltips are labels and shortcut hints with nothing to
 *    hover or click inside them, so closing on the trigger's own
 *    `pointerleave` is the right behaviour. Pass `disableHoverableContent={false}`
 *    on a Provider or a Tooltip that genuinely needs the bubble to be hoverable.
 *
 * 2. An open tooltip also closes when the pointer leaves the page or the
 *    window loses focus (`subscribePointerExit`), the one case where even the
 *    trigger's `pointerleave` may never fire.
 */

/**
 * Radix's own "another tooltip opened" event. Every open tooltip's content
 * listens for it and closes through Radix's normal close path (so the
 * provider's skip-delay bookkeeping stays right). Pinned by
 * components/ui/__tests__/tooltip.test.tsx against the installed Radix.
 */
const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open"

function closeAllTooltips() {
  document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT))
}

function TooltipProvider({
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider disableHoverableContent={disableHoverableContent} {...props} />
}

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  // Mounted only while the tooltip is open (Radix's Presence), so this
  // listens exactly as long as there is something to close.
  React.useEffect(() => subscribePointerExit(closeAllTooltips), [])
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
