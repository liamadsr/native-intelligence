'use client'

/**
 * The SEO pages' header controls. In a card they are the card header's
 * (Liam, 11-22: "this should all move into the header"), on its glass like
 * the other pages' there: the page's press with words (Check now, New
 * tracker) a pill, its "…" a round icon button. Outside a card the page's
 * own header row keeps the buttons it always had.
 */
import * as React from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CARD_HEADER_ICON_BUTTON, CARD_HEADER_PILL_BUTTON } from '@/components/chat-cards/card-header-button'
import { useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { cn } from '@/lib/utils'

/** Whether the page is drawn in a card, whose header takes its title and controls. */
export function useInCard(): boolean {
  return useCardHeaderSlots() !== null
}

type ButtonAttrs = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>

/** The page's main press: a pill in the card's header, the small solid button in the page's own row. */
export function SeoHeaderAction({ children, ...props }: ButtonAttrs) {
  if (useInCard()) {
    return (
      <button type="button" {...props} className={CARD_HEADER_PILL_BUTTON}>
        {children}
      </button>
    )
  }
  return (
    <Button size="sm" className="h-8" {...props}>
      {children}
    </Button>
  )
}

/** The "…" that opens the page's menu (a PopoverTrigger's child, so it takes the trigger's ref and props). */
export const SeoHeaderMore = React.forwardRef<HTMLButtonElement, ButtonAttrs>(function SeoHeaderMore(props, ref) {
  const inCard = useInCard()
  if (inCard) {
    return (
      <button
        ref={ref}
        type="button"
        title="More"
        aria-label="More"
        {...props}
        className={cn('grid size-6 shrink-0 place-items-center data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground', CARD_HEADER_ICON_BUTTON)}
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} aria-hidden />
      </button>
    )
  }
  return (
    <Button ref={ref} variant="ghost" size="icon" title="More" aria-label="More" {...props} className="h-8 w-8 text-muted-foreground hover:text-foreground">
      <MoreHorizontal className="h-4 w-4" />
    </Button>
  )
})

/** A place's name in the card header's breadcrumb ("Rankings › example.com"), with what stands beside it. */
export function SeoPlaceLabel({ name, children, ...data }: { name: string; children?: React.ReactNode } & { [attr: `data-${string}`]: string }) {
  return (
    <>
      <span {...data} className="min-w-0 truncate font-medium" title={name}>
        {name}
      </span>
      {children}
    </>
  )
}
