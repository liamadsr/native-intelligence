'use client'

/**
 * A custom field as a row column (`custom_fields.<key>` in a view's display
 * properties): the record's value, formatted for its type, in the same chip
 * the row's built-in cells use, with the field's name on hover. Read-only:
 * the record's panel is where its fields are edited (CustomFieldsGroup).
 * Renders nothing when the record has no value (hide empty widgets).
 */
import { cn } from '@/lib/utils'
import { relationIds } from '@/lib/crm/custom-field-types'
import { customFieldKeyOf, formatCustomFieldValue } from '@/lib/views/custom-field-columns'
import type { ViewEntityType } from '@/lib/views/types'
import { useCustomFieldDefinitions } from '../hooks/use-custom-field-definitions'

const chipClass = 'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap'

export function CustomFieldCell({
  item,
  property,
  entityType,
}: {
  item: Record<string, unknown>
  property: string
  entityType: ViewEntityType
}) {
  const key = customFieldKeyOf(property)
  const defs = useCustomFieldDefinitions(entityType, key !== null)
  if (!key) return null
  const values = item.custom_fields
  const raw = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>)[key] : undefined
  const def = defs.find((d) => d.key === key)
  // A row has no names for the records a relation links: it says how many.
  const linked = def?.field_type === 'relation' ? relationIds(raw).length : 0
  const text = formatCustomFieldValue(def?.field_type, raw) || (linked ? `${linked} linked` : '')
  if (!text) return null
  return (
    <span
      data-custom-field-cell={key}
      title={def ? `${def.label}: ${text}` : text}
      className={cn(chipClass, 'max-w-[12rem] truncate', def?.field_type === 'number' && 'tabular-nums')}
    >
      {text}
    </span>
  )
}
