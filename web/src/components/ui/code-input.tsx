'use client'

/**
 * A one-time code as a row of boxes (the phone's 6-digit code:
 * components/communication/phone-section.tsx). One real input lies over the
 * boxes, invisible, so typing, deleting, pasting (any shape: "123 456",
 * "123-456", a whole text) and the phone's own code autofill
 * (autocomplete="one-time-code") all work as in any field; the boxes only draw
 * what it holds, and where the next digit goes. `onComplete` fires once all
 * the digits are in.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The code in what was typed or pasted. A whole text ("Your Dial8 code is
 * 123 456") has other digits in it: a group of exactly `length` digits (a
 * space or dash inside it allowed) wins; failing that, every digit, in order.
 */
export function codeFrom(raw: string, length: number): string {
  for (const group of raw.match(/\d[\d\s-]*\d|\d/g) ?? []) {
    const digits = group.replace(/\D/g, '')
    if (digits.length === length) return digits
  }
  return raw.replace(/\D/g, '').slice(0, length)
}

export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  invalid = false,
  autoFocus = false,
  label = 'Verification code',
  className,
}: {
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  length?: number
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  label?: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  // Refocused after it was turned off (a wrong code, cleared): the person types again at once.
  useEffect(() => {
    if (!disabled && autoFocus && value === '') ref.current?.focus()
  }, [disabled, autoFocus, value])

  const take = (raw: string) => {
    const next = codeFrom(raw, length)
    if (next === value) return
    onChange(next)
    if (next.length === length) onComplete?.(next)
  }

  // The caret always at the end: the boxes fill left to right.
  const toEnd = () => {
    const input = ref.current
    if (input && (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length)) {
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }

  const active = Math.min(value.length, length - 1)

  return (
    <div className={cn('relative grid w-full gap-3', className)} style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }} data-code-input="">
      {Array.from({ length }, (_, i) => (
        <span
          key={i}
          aria-hidden
          data-code-box={i}
          className={cn(
            'flex aspect-[7/8] max-h-16 items-center justify-center rounded-xl border bg-background text-2xl font-medium tabular-nums transition-[border-color,box-shadow]',
            invalid ? 'border-destructive text-destructive' : 'border-border',
            focused && !disabled && !invalid && i === active && 'border-foreground/60 ring-4 ring-foreground/5',
            disabled && 'opacity-60',
          )}
        >
          {value[i] ?? (focused && !disabled && i === active ? <span className="h-7 w-px animate-pulse bg-foreground motion-reduce:animate-none" /> : null)}
        </span>
      ))}
      <input
        ref={ref}
        value={value}
        onChange={(e) => take(e.target.value)}
        onPaste={(e) => {
          e.preventDefault()
          take(e.clipboardData.getData('text'))
        }}
        onFocus={() => {
          setFocused(true)
          requestAnimationFrame(toEnd)
        }}
        onBlur={() => setFocused(false)}
        onSelect={toEnd}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        spellCheck={false}
        data-code-field=""
        // Over the boxes, unseen: 16px so a phone doesn't zoom in on focus.
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-base text-transparent caret-transparent outline-none selection:bg-transparent disabled:cursor-default"
      />
    </div>
  )
}
