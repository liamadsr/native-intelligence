'use client'

import * as React from 'react'
import { CopyValueButton } from '@/components/views/copy-value-button'

/**
 * One plain-text property row for the detail-panel sidebars (domain, email,
 * phone, job title…): icon, borderless input, hover-reveal copy button, and an
 * optional trailing adornment (the enrichment provenance dot).
 *
 * The contact and company panels each had this exact row copy-pasted per
 * field. Centralising it is what let the copy affordance land on every field
 * at once instead of being wired row by row.
 *
 * `onChange` fires per keystroke (optimistic local state); `onCommit` fires
 * on blur with the final value — the panels PATCH there.
 */
export function TextPropertyRow({
  icon,
  value,
  onChange,
  onCommit,
  placeholder,
  adornment,
}: {
  icon: React.ReactNode
  value: string | null | undefined
  onChange: (value: string) => void
  onCommit: (value: string) => void
  placeholder: string
  /** Rendered after the copy button — e.g. `<EnrichedFieldMark />`. */
  adornment?: React.ReactNode
}) {
  return (
    <div className="group/row flex h-8 items-center gap-2 px-2">
      {icon}
      <input
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        placeholder={placeholder}
      />
      <CopyValueButton value={value} label={placeholder} />
      {adornment}
    </div>
  )
}
