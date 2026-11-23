'use client'

/**
 * A views page's layout, one icon per layout, in its header island (Liam,
 * 11-21: "now we have these three views but they're kinda hidden I want to
 * move it to the header island", from his picture): a capsule of segments,
 * the one in use lifted, each named by its tooltip. Arrow keys move between
 * them (a radio group). Nothing with fewer than two layouts to pick from.
 */
import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '@/lib/utils'
import type { ViewLayout } from '@/lib/views/types'
import type { LayoutOption } from './view-layouts'

export function ViewLayoutSwitcher({
  options,
  value,
  onChange,
  className,
}: {
  options: LayoutOption[]
  value: ViewLayout
  onChange: (layout: ViewLayout) => void
  className?: string
}) {
  if (options.length < 2) return null
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as ViewLayout)
      }}
      aria-label="Layout"
      data-view-layout-switcher=""
      // overflow-hidden: the end segments take the capsule's round ends.
      // Compact (Liam, 11-21: "a bit too large"; 11-22, "good size … like apple made it"): 24px tall like every header control, 28px a segment, 14px icons.
      className={cn('flex h-6 shrink-0 items-center overflow-hidden rounded-full bg-foreground/[0.05]', className)}
    >
      {options.map(({ value: layout, label, Icon }) => (
        <ToggleGroupPrimitive.Item
          key={layout}
          value={layout}
          aria-label={label}
          title={label}
          data-layout-option={layout}
          className="flex h-full w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=on]:bg-foreground/[0.1] data-[state=on]:text-foreground motion-reduce:transition-none"
        >
          <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}
