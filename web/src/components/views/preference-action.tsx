'use client'

import { createContext, forwardRef, useContext } from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const PreferencesActionsContext = createContext(false)
export const usePreferencesActions = () => useContext(PreferencesActionsContext)

export const PREFERENCE_ACTION_CLASS = 'h-auto min-h-8 w-full justify-start gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm font-normal whitespace-normal shadow-none hover:bg-muted/50'

export function PreferenceActionGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  const inPreferences = usePreferencesActions()
  return <div className={inPreferences ? 'flex flex-col gap-0.5 [&>.w-px]:hidden' : className}>{children}</div>
}

/** Keeps toolbar controls compact in standalone views, and gives the same
 * control a descriptive row inside a window's preferences. Forwards Radix refs. */
export const PreferenceActionButton = forwardRef<HTMLButtonElement, ButtonProps & {
  label?: string
}>(function PreferenceActionButton({ label, children, className, variant, ...props }, ref) {
  const inPreferences = usePreferencesActions()
  return (
    <Button
      ref={ref}
      variant={inPreferences ? 'ghost' : variant}
      aria-label={label}
      {...props}
      className={cn(className, inPreferences && PREFERENCE_ACTION_CLASS)}
    >
      {children}
      {inPreferences && label && <span className="min-w-0 flex-1">{label}</span>}
    </Button>
  )
})
