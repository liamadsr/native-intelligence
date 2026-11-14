'use client'

/**
 * "Send later", beside a composer's Send: Tomorrow at 8:00 AM, the next
 * Monday at 8:00 AM (not offered when tomorrow is Monday), or a date and time
 * the person picks (the browser's timezone, future times only). The choice
 * goes to `onSchedule`; the caller schedules it (src/lib/email/send-later.ts)
 * and closes its composer.
 */
import { useState } from 'react'
import { CalendarClock, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { minPickValue, pickedSendAt, sendLaterPresets } from '@/lib/email/send-later'

interface SendLaterButtonProps {
  onSchedule: (at: Date) => void | Promise<unknown>
  disabled?: boolean
  /** The composer's button size (the dialog's footer is h-8). */
  className?: string
  /** For tests: what "now" is. */
  now?: () => Date
}

const ROW = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'

export function SendLaterButton({ onSchedule, disabled, className, now = () => new Date() }: SendLaterButtonProps) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const at = picked ? pickedSendAt(picked, now()) : null

  const choose = async (when: Date) => {
    if (busy) return
    setBusy(true)
    try {
      await onSchedule(when)
      setOpen(false)
      setPicking(false)
      setPicked('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setPicking(false)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('gap-1.5', className)} disabled={disabled || busy} data-send-later="">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
          Send later
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1">
        {sendLaterPresets(now()).map((p) => (
          <button key={p.id} type="button" className={ROW} data-send-later-preset={p.id} disabled={busy} onClick={() => void choose(p.at)}>
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {p.label}
          </button>
        ))}
        {!picking ? (
          <button type="button" className={ROW} data-send-later-pick="" disabled={busy} onClick={() => setPicking(true)}>
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
            Pick a date and time…
          </button>
        ) : (
          <div className="space-y-2 border-t border-border/60 p-2">
            <input
              type="datetime-local"
              aria-label="Send at"
              min={minPickValue(now())}
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              autoFocus
            />
            {picked && !at && <p className="text-xs text-destructive">Pick a time in the future</p>}
            <Button size="sm" className="h-7 w-full" disabled={!at || busy} onClick={() => at && void choose(at)}>
              Schedule
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
