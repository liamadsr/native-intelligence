'use client'

import * as React from 'react'
import { OptionalProperty } from '@/components/views/property-layout'
import { TextPropertyRow } from './text-property-row'

/**
 * A typed property that is optional (a contact's job title, a company's
 * website): the TextPropertyRow while it has a value or the focus, and a chip
 * in the panel's add strip while it has neither (property-layout.tsx). The
 * chip opens the row with its input focused, so an empty field is still one
 * click and then typing; leaving it empty puts the chip back.
 */
export function OptionalTextProperty({
  value,
  onCommit,
  ...row
}: React.ComponentProps<typeof TextPropertyRow>) {
  const [editing, setEditing] = React.useState(false)
  const set = editing || !!(value ?? '').trim()
  return (
    <OptionalProperty set={set}>
      {set ? (
        <TextPropertyRow
          {...row}
          value={value}
          autoFocus={editing}
          onCommit={(v) => {
            setEditing(false)
            onCommit(v)
          }}
        />
      ) : (
        <button
          type="button"
          data-add-text-property=""
          onClick={() => setEditing(true)}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
        >
          {row.icon}
          <span>{row.placeholder}</span>
        </button>
      )}
    </OptionalProperty>
  )
}
