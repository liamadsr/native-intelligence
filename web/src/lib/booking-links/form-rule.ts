/**
 * The rule a form in front of a booking link holds its answers to (booking
 * insights, phase 4; ./form-gate.ts): what may be stored, whether it fits
 * the form, and whether a guest's answers meet it.
 *
 * Pure and client-safe.
 */
import type { CustomFieldValue } from '@/lib/crm/custom-field-types'
import { FORM_FILES_KEY, FORM_TITLE_KEY, type DataForm } from '@/lib/forms/types'
import type { DataColumn } from '@/lib/tables/types'
import { FORM_RULE_CONDITIONS_MAX, FORM_RULE_OPS, type FormCondition, type FormRule, type FormRuleOp } from './types'

/** The ops each answer's type takes. */
export const OPS_BY_TYPE: Record<string, readonly FormRuleOp[]> = {
  title: ['equals', 'not_equals', 'contains'],
  text: ['equals', 'not_equals', 'contains'],
  email: ['equals', 'not_equals', 'contains'],
  url: ['equals', 'not_equals', 'contains'],
  phone: ['equals', 'not_equals', 'contains'],
  date: ['equals', 'not_equals', 'gte', 'lte'],
  select: ['equals', 'not_equals', 'in'],
  multi_select: ['contains', 'in'],
  number: ['equals', 'not_equals', 'gte', 'lte'],
  currency: ['equals', 'not_equals', 'gte', 'lte'],
  checkbox: ['is_true', 'is_false'],
}

/** A stored rule, or null when it isn't one (no rule: everyone who sends the form qualifies). Pure. */
export function readFormRule(value: unknown): FormRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const all = (value as { all?: unknown }).all
  if (!Array.isArray(all)) return null
  const out: FormCondition[] = []
  for (const c of all.slice(0, FORM_RULE_CONDITIONS_MAX) as Array<Record<string, unknown>>) {
    if (!c || typeof c.field !== 'string' || !(FORM_RULE_OPS as readonly unknown[]).includes(c.op)) return null
    const v = c.value
    const value = typeof v === 'string' || typeof v === 'number' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
    out.push({ field: c.field, op: c.op as FormRuleOp, ...(value !== undefined ? { value } : {}) })
  }
  return { all: out }
}

/** The type a form field's answer has: its column's, 'title' for the row's name, null when it can't be ruled on. Pure. */
function fieldType(field: string, columns: readonly Pick<DataColumn, 'key' | 'field_type' | 'deleted_at'>[]): string | null {
  if (field === FORM_TITLE_KEY) return 'title'
  if (field === FORM_FILES_KEY) return null
  const col = columns.find((c) => c.key === field && !c.deleted_at)
  return col && OPS_BY_TYPE[col.field_type] ? col.field_type : null
}

/**
 * Why this rule can't stand on this form, or null: each condition names one
 * of the form's own fields, an op its type takes, and a value of the right
 * kind (a select's among its options). Pure.
 */
export function ruleProblem(rule: FormRule, form: Pick<DataForm, 'fields'>, columns: readonly Pick<DataColumn, 'key' | 'label' | 'field_type' | 'options' | 'deleted_at'>[]): string | null {
  if (rule.all.length > FORM_RULE_CONDITIONS_MAX) return `At most ${FORM_RULE_CONDITIONS_MAX} conditions.`
  for (const c of rule.all) {
    const field = form.fields.find((f) => f.key === c.field)
    if (!field) return `The form has no field "${c.field}".`
    const type = fieldType(c.field, columns)
    if (!type) return `"${field.label}" can't be checked.`
    if (!OPS_BY_TYPE[type].includes(c.op)) return `"${field.label}" takes ${OPS_BY_TYPE[type].join(', ')}.`
    if (c.op === 'is_true' || c.op === 'is_false') continue
    if (c.op === 'in') {
      if (!Array.isArray(c.value) || !c.value.length) return `"${field.label}": in takes a list of values.`
    } else if (c.value === undefined || Array.isArray(c.value) || c.value === '') {
      return `"${field.label}": ${c.op} takes one value.`
    }
    if ((type === 'number' || type === 'currency') && (c.op === 'gte' || c.op === 'lte' || c.op === 'equals' || c.op === 'not_equals') && !Number.isFinite(Number(c.value))) return `"${field.label}" is a number: compare it with one.`
    if (type === 'select' || type === 'multi_select') {
      const options = columns.find((col) => col.key === c.field)?.options ?? []
      const given = Array.isArray(c.value) ? c.value : [String(c.value)]
      const unknown = given.find((v) => !options.includes(v))
      if (unknown !== undefined) return `"${field.label}" has no choice "${unknown}".`
    }
  }
  return null
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

/** A value as a number: a number, a currency's amount, or numeric text. Pure. */
function numberOf(value: CustomFieldValue | undefined): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && !Array.isArray(value) && 'amount' in value) return numberOf((value as { amount: CustomFieldValue }).amount)
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** Whether one condition holds for one answer (missing is never a match, but for not_equals and is_false). Pure. */
export function conditionMet(c: FormCondition, value: CustomFieldValue | undefined): boolean {
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
  switch (c.op) {
    case 'is_true':
      return value === true
    case 'is_false':
      return value !== true
    case 'in': {
      const wanted = new Set((Array.isArray(c.value) ? c.value : []).map(norm))
      return !empty && (Array.isArray(value) ? value : [value]).some((v) => wanted.has(norm(v)))
    }
    case 'contains':
      if (empty) return false
      return Array.isArray(value) ? value.some((v) => norm(v) === norm(c.value)) : norm(value).includes(norm(c.value))
    case 'gte':
    case 'lte': {
      if (empty) return false
      const a = numberOf(value)
      const b = numberOf(c.value as CustomFieldValue)
      if (a !== null && b !== null) return c.op === 'gte' ? a >= b : a <= b
      // A date: ISO text compares in order.
      return c.op === 'gte' ? String(value) >= String(c.value) : String(value) <= String(c.value)
    }
    case 'equals':
    case 'not_equals': {
      let same = false
      if (!empty) {
        const a = numberOf(value)
        const b = numberOf(c.value as CustomFieldValue)
        // A number (or a currency's amount) compares as a number; anything else as words, case aside.
        const numeric = typeof c.value === 'number' || (typeof value !== 'string' && !Array.isArray(value) && a !== null)
        same = numeric ? a !== null && b !== null && a === b : norm(Array.isArray(value) ? value.join(',') : value) === norm(c.value)
      }
      return c.op === 'equals' ? same : !same
    }
  }
}

/** Whether the answers meet the rule: every condition (none: yes). Pure. */
export function rulePasses(rule: FormRule | null, answers: { title: string; values: Record<string, CustomFieldValue> }): boolean {
  if (!rule) return true
  return rule.all.every((c) => conditionMet(c, c.field === FORM_TITLE_KEY ? answers.title : answers.values[c.field]))
}
