/**
 * Forms (phase 1, migration 660): a public front door on a table. A form
 * takes a submission from someone outside the workspace and writes it as ONE
 * new row of ONE table. Its link can do nothing else: it never reads, edits
 * or deletes a row, and it fills only the fields the form lists.
 *
 * Client-safe: plain types and constants only.
 */
import type { CustomFieldType } from '@/lib/crm/custom-fields'

/** A field's key when it fills the row's name (its title) and not a column. */
export const FORM_TITLE_KEY = '$title'

/**
 * The column types a form may fill. Never a person or a relation (a stranger
 * must not pick a member or a record by id), and never a computed column.
 */
export const FORM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'currency'] as const satisfies readonly CustomFieldType[]
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export function isFormFieldType(v: unknown): v is FormFieldType {
  return typeof v === 'string' && (FORM_FIELD_TYPES as readonly string[]).includes(v)
}

export const FORM_ACCESS = ['public', 'members'] as const
/** public: anyone holding the link. members: only a signed-in member of the workspace. */
export type FormAccess = (typeof FORM_ACCESS)[number]

/** The limits the database enforces too (660). */
export const FORM_LIMITS = {
  name: 200,
  fields: 40,
  label: 60,
  thanks: 500,
  origins: 10,
  /** A row's name from a form: one line, short (it is shown wherever the row is named). */
  title: 200,
  externalId: 120,
} as const

/** One thing a submission may fill. */
export interface FormField {
  /** A column's key, or {@link FORM_TITLE_KEY} for the row's name. */
  key: string
  /** What the form calls it; a posted field is matched by it too. */
  label: string
  required: boolean
}

export interface DataForm {
  id: string
  workspaceId: string
  tableId: string
  name: string
  fields: FormField[]
  access: FormAccess
  allowedOrigins: string[]
  thanks: string | null
  active: boolean
  /** The start of its link's secret, to tell links apart. Never the secret. */
  keyPrefix: string
  /** Who its rows are written as. */
  createdBy: string | null
  createdAt: string
  updatedAt: string
  lastSubmittedAt: string | null
}
