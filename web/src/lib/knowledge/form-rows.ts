/**
 * Rows a public form wrote (data_row.from_form, migration 660: set in the
 * row's own insert, never changed). Their title and the text in their values
 * are what a stranger typed. Wherever such a row's text reaches a model it
 * goes inside the untrusted fence (src/lib/email/untrusted.ts); where only a
 * name is needed outside one, the row goes by FORM_ROW_NAME instead. A row a
 * person wrote is shown as it is. People see a form row's own words: this is
 * for what a model reads.
 *
 * The table tools (src/lib/ai/tools/tables.ts) and the deal tools
 * (src/lib/crm/deals.ts) apply the same rule in their own words.
 *
 * Client-safe and pure: the entity registry imports it.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'

/** A form row's name outside any fence: never its title. */
export const FORM_ROW_NAME = 'a row from a form'

/** Whether a row (any shape that read `from_form`) was written by a form. */
export function isFormRow(row: { from_form?: unknown } | null | undefined): boolean {
  return row?.from_form === true
}

/**
 * A form row's value as a model reads it: a string, or each string of a
 * list, inside the WEB fence (any marker in it defused); numbers, flags and
 * empties as they are.
 */
export function fenceFormValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() ? (wrapUntrusted(value, 'WEB') ?? value) : value
  if (Array.isArray(value)) return value.map(fenceFormValue)
  return value
}
