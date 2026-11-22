'use client'

/**
 * The conditional-formatting panel, at the grid's right. It lists the sheet's
 * rules in the engine's priority order with a plain description, and adds,
 * edits, deletes and reorders them. The engine evaluates every rule and the
 * grid draws the result; this panel only builds the rules.
 *
 * This goes past Macro, which only keeps the rules an imported file carried.
 */
import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { CfRuleInput, Dxf, TextOperator, ValueOperator } from '@ironcalc/wasm'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { rangeName, type CellRange } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import { PALETTE } from '@/lib/spreadsheets/formats'

interface Props {
  workbook: WorkbookController
  onClose: () => void
  onMessage: (message: string) => void
}

/** The kinds the editor offers, in the order they appear in the menu. */
type RuleKind =
  | 'greaterThan'
  | 'lessThan'
  | 'between'
  | 'equal'
  | 'notEqual'
  | 'textContains'
  | 'textStartsWith'
  | 'textEndsWith'
  | 'blank'
  | 'notBlank'
  | 'error'
  | 'duplicate'
  | 'unique'
  | 'aboveAverage'
  | 'belowAverage'
  | 'formula'
  | 'colorScale2'
  | 'colorScale3'

const KIND_LABELS: Record<RuleKind, string> = {
  greaterThan: 'Greater than',
  lessThan: 'Less than',
  between: 'Between',
  equal: 'Equal to',
  notEqual: 'Not equal to',
  textContains: 'Text contains',
  textStartsWith: 'Text starts with',
  textEndsWith: 'Text ends with',
  blank: 'Is blank',
  notBlank: 'Is not blank',
  error: 'Is an error',
  duplicate: 'Duplicate values',
  unique: 'Unique values',
  aboveAverage: 'Above average',
  belowAverage: 'Below average',
  formula: 'Custom formula',
  colorScale2: 'Color scale (2 colors)',
  colorScale3: 'Color scale (3 colors)',
}

const needsOneValue: RuleKind[] = ['greaterThan', 'lessThan', 'equal', 'notEqual', 'textContains', 'textStartsWith', 'textEndsWith', 'formula']
const isColorScale = (k: RuleKind) => k === 'colorScale2' || k === 'colorScale3'

interface Draft {
  kind: RuleKind
  value1: string
  value2: string
  fill: string | null
  textColor: string | null
  bold: boolean
  italic: boolean
  /** Color-scale colors: low, (mid), high. */
  low: string
  mid: string
  high: string
}

const BLANK_DRAFT: Draft = {
  kind: 'greaterThan',
  value1: '',
  value2: '',
  fill: '#FEF3C7',
  textColor: null,
  bold: false,
  italic: false,
  low: '#FDE2DF',
  mid: '#FEF3C7',
  high: '#DDF3E1',
}

/** A plain-words line for a stored rule. */
export function describeRule(rule: CfRuleInput | { type: string } & Record<string, unknown>): string {
  const r = rule as Record<string, unknown>
  switch (r.type) {
    case 'CellIs': {
      const op = r.operator as ValueOperator
      const words: Record<string, string> = {
        GreaterThan: 'greater than',
        GreaterThanOrEqual: 'greater than or equal to',
        LessThan: 'less than',
        LessThanOrEqual: 'less than or equal to',
        Equal: 'equal to',
        NotEqual: 'not equal to',
        Between: 'between',
        NotBetween: 'not between',
      }
      const value = op === 'Between' || op === 'NotBetween' ? `${r.formula} and ${r.formula2}` : r.formula
      return `Value ${words[op] ?? op} ${value}`
    }
    case 'Text': {
      const op = r.operator as TextOperator
      const words: Record<string, string> = { Contains: 'contains', DoesNotContain: 'does not contain', BeginsWith: 'starts with', EndsWith: 'ends with', Equals: 'is' }
      return `Text ${words[op] ?? op} "${r.value}"`
    }
    case 'Formula':
      return `Custom formula ${r.formula}`
    case 'Blanks':
      return 'Is blank'
    case 'NotBlanks':
      return 'Is not blank'
    case 'Errors':
      return 'Is an error'
    case 'NoErrors':
      return 'Is not an error'
    case 'DuplicateValues':
      return 'Duplicate values'
    case 'UniqueValues':
      return 'Unique values'
    case 'AboveAverage':
      return 'Above average'
    case 'BelowAverage':
      return 'Below average'
    case 'Top10':
      return `Top ${r.rank}${r.percent ? '%' : ''}`
    case 'Bottom10':
      return `Bottom ${r.rank}${r.percent ? '%' : ''}`
    case 'ColorScale':
      return `Color scale (${(r.thresholds as unknown[])?.length ?? 2} colors)`
    case 'DataBar':
      return 'Data bar'
    case 'IconSet':
    case 'IconRating':
      return 'Icon set'
    default:
      return String(r.type)
  }
}

export function ConditionalFormat({ workbook, onClose, onMessage }: Props) {
  const rules = workbook.conditionalRules()
  const [editing, setEditing] = useState<{ index: number | null; range: string; draft: Draft } | null>(null)

  const beginAdd = () => setEditing({ index: null, range: rangeName(workbook.selection().range), draft: { ...BLANK_DRAFT } })

  const beginEdit = (index: number) => {
    const view = rules.find((r) => r.index === index)
    if (!view) return
    setEditing({ index, range: view.range, draft: draftFromRule(workbook, index, view.cf_rule) })
  }

  const save = () => {
    if (!editing) return
    const range = parseRangeText(editing.range) ?? workbook.selection().range
    const rule = buildRule(editing.draft)
    if (!rule) {
      onMessage('Enter the value the rule compares against.')
      return
    }
    const result = editing.index === null ? workbook.addConditionalRule(range, rule) : workbook.updateConditionalRule(editing.index, range, rule)
    if (!result.ok) {
      onMessage(result.message)
      return
    }
    setEditing(null)
  }

  return (
    <aside aria-label="Conditional formatting" className={cn(FLOATING_CARD_CLASS, 'absolute bottom-3 right-3 top-3 z-40 flex w-[320px] max-w-[calc(100%-1.5rem)] flex-col shadow-lg')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <h2 className="flex-1 text-sm font-medium text-foreground">Conditional formatting</h2>
        <button type="button" aria-label="Close conditional formatting" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {editing ? (
        <RuleEditor
          state={editing}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rules.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No rules on this sheet yet.</p>
          ) : (
            <ul className="space-y-1">
              {rules.map((rule, i) => (
                <li key={rule.index} className="rounded-lg border border-border/50 px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{describeRule(rule.cf_rule)}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{rule.range}</span>
                    </span>
                    <button type="button" aria-label="Raise priority" disabled={i === 0} className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30" onClick={() => workbook.raiseConditionalRule(rule.index)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" aria-label="Lower priority" disabled={i === rules.length - 1} className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30" onClick={() => workbook.lowerConditionalRule(rule.index)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" aria-label="Edit rule" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => beginEdit(rule.index)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" aria-label="Delete rule" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive" onClick={() => workbook.deleteConditionalRule(rule.index)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" variant="outline" className="mt-2 w-full gap-1" disabled={workbook.readOnly} onClick={beginAdd}>
            <Plus className="h-3.5 w-3.5" /> Add rule
          </Button>
        </div>
      )}
    </aside>
  )
}

function RuleEditor({
  state,
  onChange,
  onCancel,
  onSave,
}: {
  state: { index: number | null; range: string; draft: Draft }
  onChange: (next: { index: number | null; range: string; draft: Draft }) => void
  onCancel: () => void
  onSave: () => void
}) {
  const { draft } = state
  const set = (patch: Partial<Draft>) => onChange({ ...state, draft: { ...draft, ...patch } })
  const field = 'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <label className="text-xs font-medium text-muted-foreground">Apply to range</label>
      <input aria-label="Rule range" value={state.range} spellCheck={false} className={cn(field, 'mb-3 mt-1 font-mono')} onChange={(event) => onChange({ ...state, range: event.target.value })} />

      <label className="text-xs font-medium text-muted-foreground">Format cells if</label>
      <select aria-label="Rule kind" value={draft.kind} className={cn(field, 'mb-2 mt-1')} onChange={(event) => set({ kind: event.target.value as RuleKind })}>
        {(Object.keys(KIND_LABELS) as RuleKind[]).map((k) => (
          <option key={k} value={k}>{KIND_LABELS[k]}</option>
        ))}
      </select>

      {needsOneValue.includes(draft.kind) && (
        <input
          aria-label="Value"
          value={draft.value1}
          spellCheck={false}
          placeholder={draft.kind === 'formula' ? '=A1>AVERAGE(A:A)' : draft.kind.startsWith('text') ? 'text' : '0'}
          className={cn(field, 'mb-2 font-mono')}
          onChange={(event) => set({ value1: event.target.value })}
        />
      )}
      {draft.kind === 'between' && (
        <div className="mb-2 flex gap-2">
          <input aria-label="Lower value" value={draft.value1} spellCheck={false} placeholder="low" className={cn(field, 'font-mono')} onChange={(event) => set({ value1: event.target.value })} />
          <input aria-label="Upper value" value={draft.value2} spellCheck={false} placeholder="high" className={cn(field, 'font-mono')} onChange={(event) => set({ value2: event.target.value })} />
        </div>
      )}

      {isColorScale(draft.kind) ? (
        <div className="mt-1 space-y-2">
          <Swatch label="Low color" value={draft.low} onPick={(hex) => set({ low: hex })} />
          {draft.kind === 'colorScale3' && <Swatch label="Middle color" value={draft.mid} onPick={(hex) => set({ mid: hex })} />}
          <Swatch label="High color" value={draft.high} onPick={(hex) => set({ high: hex })} />
        </div>
      ) : (
        <div className="mt-1 space-y-2">
          <Swatch label="Fill color" value={draft.fill} onPick={(hex) => set({ fill: hex })} clearable onClear={() => set({ fill: null })} />
          <Swatch label="Text color" value={draft.textColor} onPick={(hex) => set({ textColor: hex })} clearable onClear={() => set({ textColor: null })} />
          <div className="flex gap-2">
            <button type="button" aria-pressed={draft.bold} className={cn('h-7 flex-1 rounded-md border border-border text-sm font-semibold', draft.bold && 'bg-accent')} onClick={() => set({ bold: !draft.bold })}>B</button>
            <button type="button" aria-pressed={draft.italic} className={cn('h-7 flex-1 rounded-md border border-border text-sm italic', draft.italic && 'bg-accent')} onClick={() => set({ italic: !draft.italic })}>I</button>
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={onSave}>{state.index === null ? 'Add' : 'Save'}</Button>
      </div>
    </div>
  )
}

function Swatch({ label, value, onPick, clearable, onClear }: { label: string; value: string | null; onPick: (hex: string) => void; clearable?: boolean; onClear?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <button type="button" aria-label={label} className="h-6 w-6 shrink-0 rounded-md border border-border/70" style={{ backgroundColor: value ?? 'transparent' }} onClick={() => setOpen((o) => !o)} />
        <span className="flex-1 text-xs text-muted-foreground">{label}</span>
      </div>
      {open && (
        <div className="absolute left-0 top-7 z-10 grid grid-cols-5 gap-1 rounded-md border border-border/70 bg-background p-1.5 shadow-lg">
          {clearable && (
            <button type="button" className="col-span-5 mb-0.5 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => { onClear?.(); setOpen(false) }}>None</button>
          )}
          {PALETTE.map((p) => (
            <button key={p.hex} type="button" aria-label={p.name} title={p.name} className="h-5 w-5 rounded-full border border-border/70" style={{ backgroundColor: p.hex }} onClick={() => { onPick(p.hex); setOpen(false) }} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The format a non-color-scale rule applies. */
function draftFormat(draft: Draft): Dxf {
  const format: Dxf = {}
  if (draft.fill) format.fill = { color: draft.fill }
  if (draft.textColor || draft.bold || draft.italic) {
    format.font = { ...(draft.textColor ? { color: draft.textColor } : {}), ...(draft.bold ? { b: true } : {}), ...(draft.italic ? { i: true } : {}) }
  }
  return format
}

/** Build the engine's rule input from the draft, or null when a needed value is missing. */
function buildRule(draft: Draft): CfRuleInput | null {
  const format = draftFormat(draft)
  const need = (v: string) => v.trim() !== ''
  switch (draft.kind) {
    case 'greaterThan':
    case 'lessThan':
    case 'equal':
    case 'notEqual': {
      if (!need(draft.value1)) return null
      const op: ValueOperator = draft.kind === 'greaterThan' ? 'GreaterThan' : draft.kind === 'lessThan' ? 'LessThan' : draft.kind === 'equal' ? 'Equal' : 'NotEqual'
      return { type: 'CellIs', operator: op, formula: draft.value1.trim(), formula2: null, format, stop_if_true: false }
    }
    case 'between': {
      if (!need(draft.value1) || !need(draft.value2)) return null
      return { type: 'CellIs', operator: 'Between', formula: draft.value1.trim(), formula2: draft.value2.trim(), format, stop_if_true: false }
    }
    case 'textContains':
    case 'textStartsWith':
    case 'textEndsWith': {
      if (!need(draft.value1)) return null
      const op: TextOperator = draft.kind === 'textContains' ? 'Contains' : draft.kind === 'textStartsWith' ? 'BeginsWith' : 'EndsWith'
      return { type: 'Text', operator: op, value: draft.value1, format, stop_if_true: false }
    }
    case 'formula':
      if (!need(draft.value1)) return null
      return { type: 'Formula', formula: draft.value1.trim(), format, stop_if_true: false }
    case 'blank':
      return { type: 'Blanks', format, stop_if_true: false }
    case 'notBlank':
      return { type: 'NotBlanks', format, stop_if_true: false }
    case 'error':
      return { type: 'Errors', format, stop_if_true: false }
    case 'duplicate':
      return { type: 'DuplicateValues', format, stop_if_true: false }
    case 'unique':
      return { type: 'UniqueValues', format, stop_if_true: false }
    case 'aboveAverage':
      return { type: 'AboveAverage', format, stop_if_true: false }
    case 'belowAverage':
      return { type: 'BelowAverage', format, stop_if_true: false }
    case 'colorScale2':
      return { type: 'ColorScale', thresholds: [{ cfvo: 'Min', color: draft.low }, { cfvo: 'Max', color: draft.high }] }
    case 'colorScale3':
      return { type: 'ColorScale', thresholds: [{ cfvo: 'Min', color: draft.low }, { cfvo: { Percentile: 50 }, color: draft.mid }, { cfvo: 'Max', color: draft.high }] }
  }
}

/** Fill a draft from a stored rule, for editing (format read from the engine's dxf). */
function draftFromRule(workbook: WorkbookController, index: number, rule: CfRuleInput | Record<string, unknown>): Draft {
  const draft: Draft = { ...BLANK_DRAFT }
  const r = rule as Record<string, unknown>
  const dxf = workbook.model.getDxfForConditionalFormatting(workbook.sheet, index)
  if (dxf) {
    if (typeof dxf.fill?.color === 'string') draft.fill = dxf.fill.color
    if (typeof dxf.font?.color === 'string') draft.textColor = dxf.font.color
    draft.bold = dxf.font?.b ?? false
    draft.italic = dxf.font?.i ?? false
  }
  if (r.type === 'CellIs') {
    const op = r.operator as ValueOperator
    draft.kind = op === 'GreaterThan' ? 'greaterThan' : op === 'LessThan' ? 'lessThan' : op === 'Between' ? 'between' : op === 'NotEqual' ? 'notEqual' : 'equal'
    draft.value1 = String(r.formula ?? '')
    draft.value2 = String(r.formula2 ?? '')
  } else if (r.type === 'Text') {
    const op = r.operator as TextOperator
    draft.kind = op === 'BeginsWith' ? 'textStartsWith' : op === 'EndsWith' ? 'textEndsWith' : 'textContains'
    draft.value1 = String(r.value ?? '')
  } else if (r.type === 'Formula') {
    draft.kind = 'formula'
    draft.value1 = String(r.formula ?? '')
  } else if (r.type === 'Blanks') draft.kind = 'blank'
  else if (r.type === 'NotBlanks') draft.kind = 'notBlank'
  else if (r.type === 'Errors') draft.kind = 'error'
  else if (r.type === 'DuplicateValues') draft.kind = 'duplicate'
  else if (r.type === 'UniqueValues') draft.kind = 'unique'
  else if (r.type === 'AboveAverage') draft.kind = 'aboveAverage'
  else if (r.type === 'BelowAverage') draft.kind = 'belowAverage'
  else if (r.type === 'ColorScale') {
    const thresholds = (r.thresholds as Array<{ color: unknown }>) ?? []
    draft.kind = thresholds.length >= 3 ? 'colorScale3' : 'colorScale2'
    if (typeof thresholds[0]?.color === 'string') draft.low = thresholds[0].color
    if (thresholds.length >= 3 && typeof thresholds[1]?.color === 'string') draft.mid = thresholds[1].color
    const last = thresholds[thresholds.length - 1]
    if (typeof last?.color === 'string') draft.high = last.color
  }
  return draft
}

function parseRangeText(text: string): CellRange | null {
  const m = /^\s*([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?\s*$/.exec(text)
  if (!m) return null
  const col = (s: string) => {
    let n = 0
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n
  }
  const c1 = col(m[1])
  const r1 = Number(m[2])
  const c2 = m[3] ? col(m[3]) : c1
  const r2 = m[4] ? Number(m[4]) : r1
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}
