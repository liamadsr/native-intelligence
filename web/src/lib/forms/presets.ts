/**
 * Ready-made forms for the tables a starter makes (src/lib/tables/templates.ts).
 * A preset is data: the columns it needs, by key and type, and the fields a
 * new form on such a table starts with (which are ticked, in what order,
 * with what labels), with a name and a button. A table gets a preset when it
 * has every column the preset names, whatever it is called, so a table made
 * from the Quote requests starter, or one built by hand with the same
 * columns, offers it alike.
 *
 * Nothing is made from a preset by itself: making a table from a starter
 * makes no form and no link. Only the builder's "New form" screen
 * (src/components/tables/forms-panel.tsx) and create_form, when they are
 * not told which fields, start from it.
 *
 * Client-safe and pure.
 */
import type { DataColumnType } from '@/lib/tables/types'
import { FORM_TITLE_KEY, type FormField } from './types'

export interface FormPreset {
  id: 'quote_request'
  /** The new form's name and its button. */
  name: string
  submitLabel: string
  /** Each column the preset needs: its key and its type. */
  columns: Readonly<Record<string, DataColumnType>>
  /** The fields a new form starts with, in order. */
  fields: readonly FormField[]
}

/**
 * Taking quote requests (the Quote requests starter): who is asking, where,
 * what for and when. Budget and Status stay off the form: the business sets
 * them. The contact is linked through the table's Customer column, as on any
 * table that links contacts (./submit.ts).
 */
export const QUOTE_REQUEST_PRESET: FormPreset = {
  id: 'quote_request',
  name: 'Request a quote',
  submitLabel: 'Request a quote',
  columns: {
    email: 'email',
    phone: 'phone',
    address: 'text',
    service: 'select',
    size: 'text',
    preferred_date: 'date',
    message: 'text',
  },
  fields: [
    { key: FORM_TITLE_KEY, label: 'Your name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'phone', label: 'Phone', required: false },
    { key: 'address', label: 'Address', required: false },
    { key: 'service', label: 'Service', required: false },
    { key: 'size', label: 'Size', required: false },
    { key: 'preferred_date', label: 'Preferred date', required: false },
    { key: 'message', label: 'Message', required: false },
  ],
}

export const FORM_PRESETS: readonly FormPreset[] = [QUOTE_REQUEST_PRESET]

/** The preset a table with these columns gets: the first whose every column it has, live and of the right type; else null. Pure. */
export function formPresetFor(columns: ReadonlyArray<{ key: string; field_type: string; deleted_at?: string | null }>): FormPreset | null {
  const live = new Map(columns.filter((c) => !c.deleted_at).map((c) => [c.key, c.field_type]))
  return FORM_PRESETS.find((p) => Object.entries(p.columns).every(([key, type]) => live.get(key) === type)) ?? null
}
