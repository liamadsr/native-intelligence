'use client'

import { useLayoutEffect, useRef } from 'react'
import { caretAfterDigits, digitsAfterEdit, formatNanp } from '@/lib/sms/phone-format'
import { cn } from '@/lib/utils'

/**
 * A US or Canadian mobile number on a public scheduling page: a fixed +1 and
 * the ten digits shown as they're typed, (555) 123-4567 (src/lib/sms/
 * phone-format.ts, the phone settings' field). Holds digits only; the page
 * sends nanpE164(digits).
 */
export function MobileInput({ id, digits, onDigits, invalid, disabled }: { id: string; digits: string; onDigits: (digits: string) => void; invalid?: boolean; disabled?: boolean }) {
  const field = useRef<HTMLInputElement>(null)
  // Where the caret goes after a reformat, in digits (an edit mid-number keeps its place).
  const caret = useRef<number | null>(null)
  const formatted = formatNanp(digits)

  useLayoutEffect(() => {
    const input = field.current
    if (caret.current === null || !input || document.activeElement !== input) return
    const at = caretAfterDigits(formatted, caret.current)
    input.setSelectionRange(at, at)
    caret.current = null
  }, [formatted])

  return (
    <div
      className={cn(
        'flex h-9 w-full cursor-text items-center rounded-md border bg-transparent px-3 text-base shadow-xs transition-colors md:text-sm',
        invalid ? 'border-destructive' : 'border-input focus-within:border-foreground/30',
      )}
      onClick={() => field.current?.focus()}
    >
      <span aria-hidden className={cn('mr-1.5 tabular-nums', digits ? 'text-foreground' : 'text-muted-foreground')}>
        +1
      </span>
      <input
        ref={field}
        id={id}
        value={formatted}
        onChange={(e) => {
          const next = digitsAfterEdit(digits, e.target.value, e.target.selectionStart)
          caret.current = next.caretDigits
          onDigits(next.digits)
        }}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder="(555) 010-0100"
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="h-full min-w-0 flex-1 bg-transparent tabular-nums outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
    </div>
  )
}
