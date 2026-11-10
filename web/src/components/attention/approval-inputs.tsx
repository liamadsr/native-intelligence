'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { APPROVAL_FIELD_CLIP_CHARS, approvalInputFields } from '@/lib/attention/approval-input'

/**
 * Every input an approval card's held call will run with (A5): the whole
 * stored input, target-like keys first, in a scrollable box. A long value is
 * clipped per field, with "Show all" to read it whole.
 *
 * A loop step's card (F4, payload.editable) can be edited before it runs:
 * with `onChange`, each text field is a box the person types into, and what
 * the box shows is what runs (the server takes the same keys only). Fields
 * that are not text stay as they are.
 */
export function ApprovalInputs({
  input,
  onChange,
}: {
  input: unknown
  /** Edit mode: called with the whole input after each change. */
  onChange?: (next: Record<string, unknown>) => void
}) {
  const fields = approvalInputFields(input)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  if (!fields.length) {
    return <p data-approval-inputs="" className="mb-2 text-xs text-muted-foreground">No inputs.</p>
  }
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  // `ph-no-capture`: a held email send's input is its recipients, subject and
  // body; session replay blocks it (Native Intelligence never stores mail text).
  return (
    <dl
      data-approval-inputs=""
      {...(onChange ? { 'data-approval-editing': '' } : {})}
      className="ph-no-capture mb-2 max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-2 text-[11px] leading-snug"
    >
      {fields.map((field) => {
        const editableField = !!onChange && !!record && typeof record[field.key] === 'string'
        if (editableField) {
          return (
            <div key={field.key} data-approval-field={field.key}>
              <dt className={cn('font-medium', field.target ? 'text-foreground' : 'text-muted-foreground')}>{field.key}</dt>
              <dd>
                <textarea
                  aria-label={`Edit ${field.key}`}
                  value={record[field.key] as string}
                  rows={Math.min(6, Math.max(1, Math.ceil((record[field.key] as string).length / 48)))}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onChange({ ...record, [field.key]: e.target.value })}
                  className="w-full resize-y rounded border border-border/60 bg-background px-1.5 py-1 font-mono text-[11px] text-foreground/90 focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </dd>
            </div>
          )
        }
        const long = field.value.length > APPROVAL_FIELD_CLIP_CHARS
        const shown = long && !open.has(field.key) ? `${field.value.slice(0, APPROVAL_FIELD_CLIP_CHARS)}…` : field.value
        return (
          <div key={field.key} data-approval-field={field.key}>
            <dt className={cn('font-medium', field.target ? 'text-foreground' : 'text-muted-foreground')}>{field.key}</dt>
            <dd className="whitespace-pre-wrap break-words font-mono text-foreground/90">{shown}</dd>
            {long && (
              <button
                type="button"
                className="mt-0.5 text-[11px] text-primary underline-offset-2 hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen((prev) => {
                    const next = new Set(prev)
                    if (next.has(field.key)) next.delete(field.key)
                    else next.add(field.key)
                    return next
                  })
                }}
              >
                {open.has(field.key) ? 'Show less' : 'Show all'}
              </button>
            )}
          </div>
        )
      })}
    </dl>
  )
}
