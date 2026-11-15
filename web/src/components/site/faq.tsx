'use client'

/** A list of questions that open in place. Shared by the homepage and the feature pages. */
import { clsx } from 'clsx'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-5 text-left"
      >
        <span className="font-medium text-foreground">{q}</span>
        <ChevronDown className={clsx('h-5 w-5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <p className="pb-5 text-muted-foreground">{a}</p>}
    </div>
  )
}

export function FaqList({ items }: { items: readonly { q: string; a: string }[] }) {
  return (
    <div>
      {items.map((item) => (
        <FaqItem key={item.q} q={item.q} a={item.a} />
      ))}
    </div>
  )
}
