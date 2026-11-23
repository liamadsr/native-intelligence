'use client'

/**
 * A form in front of a booking link, in its dialog (booking insights, phase
 * 4): which form the guest answers first, the conditions their answers must
 * all meet to go on to the times, and the line the others read. The forms
 * offered are the ones the person may use (/api/account/booking-links/forms:
 * anyone-can-fill, on, no files, on a table they can change); the server
 * checks the pick again (src/lib/booking-links/form-gate.ts).
 */
import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { OPS_BY_TYPE } from '@/lib/booking-links/form-rule'
import { FORM_REFUSAL_MAX, FORM_RULE_CONDITIONS_MAX, type FormCondition, type FormRuleOp } from '@/lib/booking-links/types'
import { cn } from '@/lib/utils'

export interface GateFormChoice {
  id: string
  name: string
  table_name: string
  fields: Array<{ key: string; label: string; type: string; options?: string[] }>
}

const OP_LABEL: Record<FormRuleOp, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  in: 'is one of',
  gte: 'is at least',
  lte: 'is at most',
  is_true: 'is checked',
  is_false: 'is not checked',
}

const CARD = 'divide-y rounded-lg border border-border bg-muted/30'
const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm'

/** A condition's value as its op and type want it: a list for `in`, none for a checkbox's, a number for a number's. Pure. */
export function valueFor(op: FormRuleOp, type: string, raw: string | string[] | undefined): FormCondition['value'] {
  if (op === 'is_true' || op === 'is_false') return undefined
  if (op === 'in') return Array.isArray(raw) ? raw : raw ? [raw] : []
  const text = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  if ((type === 'number' || type === 'currency') && text.trim() && Number.isFinite(Number(text))) return Number(text)
  return text
}

export function LinkFormGateEditor({
  formId,
  conditions,
  refusal,
  onChange,
}: {
  formId: string
  conditions: FormCondition[]
  refusal: string
  onChange: (patch: { formId?: string; formConditions?: FormCondition[]; formRefusal?: string }) => void
}) {
  const [forms, setForms] = useState<GateFormChoice[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/account/booking-links/forms')
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { forms?: GateFormChoice[] }
        if (live) res.ok && body.forms ? setForms(body.forms) : setError(true)
      })
      .catch(() => live && setError(true))
    return () => {
      live = false
    }
  }, [])

  const form = forms?.find((f) => f.id === formId) ?? null
  const fieldOf = (key: string) => form?.fields.find((f) => f.key === key) ?? null
  const setCondition = (i: number, next: FormCondition) => onChange({ formConditions: conditions.map((c, j) => (j === i ? next : c)) })

  return (
    <div className="space-y-3" data-link-form-gate="">
      <div className={CARD}>
        <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
          <label htmlFor="link-form" className="text-sm">
            Form
          </label>
          <select id="link-form" className={cn(SELECT, 'max-w-[60%]')} value={formId} disabled={!forms && !formId} onChange={(e) => onChange({ formId: e.target.value, formConditions: [] })}>
            <option value="">None</option>
            {formId && !form && <option value={formId}>{forms ? 'A form you can’t use' : 'Loading…'}</option>}
            {(forms ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {f.table_name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">Your forms didn&rsquo;t load. Close this and open it again.</p>}
      {forms && forms.length === 0 && !formId && <p className="text-xs text-muted-foreground">No form to use yet: make one on a table (anyone can fill it in, no files), then pick it here.</p>}

      {form && (
        <>
          <div>
            <p className="text-xs font-medium">Who goes on to book</p>
            <p className="text-xs text-muted-foreground">{conditions.length ? 'Only guests whose answers meet every condition.' : 'Everyone who sends the form. Add a condition to narrow it.'}</p>
            {conditions.length > 0 && (
              <div className={cn(CARD, 'mt-2')}>
                {conditions.map((c, i) => {
                  const field = fieldOf(c.field)
                  const ops = field ? (OPS_BY_TYPE[field.type] ?? []) : []
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-1.5 px-3 py-2" data-link-form-condition={i}>
                      <select
                        aria-label={`Condition ${i + 1} question`}
                        className={SELECT}
                        value={c.field}
                        onChange={(e) => {
                          const next = fieldOf(e.target.value)
                          const op = (next ? OPS_BY_TYPE[next.type]?.[0] : 'equals') ?? 'equals'
                          setCondition(i, { field: e.target.value, op, ...(valueFor(op, next?.type ?? 'text', '') !== undefined ? { value: valueFor(op, next?.type ?? 'text', '') } : {}) })
                        }}
                      >
                        <option value="">Pick a question</option>
                        {form.fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      {field && (
                        <select
                          aria-label={`Condition ${i + 1} test`}
                          className={SELECT}
                          value={c.op}
                          onChange={(e) => {
                            const op = e.target.value as FormRuleOp
                            const value = valueFor(op, field.type, c.value === undefined ? undefined : Array.isArray(c.value) ? c.value : String(c.value))
                            setCondition(i, { field: c.field, op, ...(value !== undefined ? { value } : {}) })
                          }}
                        >
                          {ops.map((op) => (
                            <option key={op} value={op}>
                              {OP_LABEL[op]}
                            </option>
                          ))}
                        </select>
                      )}
                      {field && c.op !== 'is_true' && c.op !== 'is_false' && (
                        <ConditionValue condition={c} field={field} index={i} onValue={(value) => setCondition(i, { field: c.field, op: c.op, value })} />
                      )}
                      <Button type="button" size="icon" variant="ghost" aria-label={`Remove condition ${i + 1}`} className="ml-auto size-7 shrink-0 text-muted-foreground shadow-none hover:text-foreground" onClick={() => onChange({ formConditions: conditions.filter((_, j) => j !== i) })}>
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
            {conditions.length < FORM_RULE_CONDITIONS_MAX && form.fields.length > 0 && (
              <Button type="button" variant="outline" size="sm" className="mt-2 -ml-3 gap-1" onClick={() => onChange({ formConditions: [...conditions, { field: '', op: 'equals', value: '' }] })}>
                <Plus className="size-3.5" />
                Add a condition
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="link-form-refusal" className="text-xs font-medium">
              What the others read <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea id="link-form-refusal" rows={2} value={refusal} maxLength={FORM_REFUSAL_MAX} placeholder="Thanks for your answers. This page can't take a booking for this request." onChange={(e) => onChange({ formRefusal: e.target.value })} />
          </div>
          <p className="text-xs text-muted-foreground">Every answer lands in {form.table_name}, whether or not they go on to book.</p>
        </>
      )}
    </div>
  )
}

function ConditionValue({ condition, field, index, onValue }: { condition: FormCondition; field: GateFormChoice['fields'][number]; index: number; onValue: (value: FormCondition['value']) => void }) {
  const label = `Condition ${index + 1} value`
  if (field.options && condition.op === 'in') {
    const chosen = Array.isArray(condition.value) ? condition.value : []
    return (
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {field.options.map((o) => (
          <label key={o} className="flex items-center gap-1 text-xs">
            <Checkbox checked={chosen.includes(o)} onCheckedChange={(v) => onValue(v === true ? [...chosen, o] : chosen.filter((x) => x !== o))} />
            {o}
          </label>
        ))}
      </div>
    )
  }
  if (field.options) {
    return (
      <select aria-label={label} className={SELECT} value={String(condition.value ?? '')} onChange={(e) => onValue(e.target.value)}>
        <option value="">Pick one</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  const numeric = field.type === 'number' || field.type === 'currency'
  return (
    <Input
      aria-label={label}
      className="h-8 w-36 bg-background"
      type={numeric ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={condition.value === undefined ? '' : String(condition.value)}
      maxLength={200}
      onChange={(e) => onValue(valueFor(condition.op, field.type, e.target.value))}
    />
  )
}
