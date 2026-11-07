'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { buildCaseDraft } from '@/lib/evals/flywheel/case-draft'
import { validateCaseDraft, type FlywheelSkillCase } from '@/lib/evals/flywheel/case-schema'
import type { AdminEvalCandidate } from './labels'

type Draft = { skill: string; case: FlywheelSkillCase }

/**
 * The case a candidate is promoted into: prefilled from the case saved on it
 * before (a reopened row), else drafted from its evidence (buildCaseDraft),
 * edited here, and checked with validateCaseDraft before it is sent (the
 * route checks it again). Fields the form doesn't edit (forbidParams) ride
 * through from the draft.
 */
export function initialDraft(row: AdminEvalCandidate): Draft {
  const saved = row.case_draft ? validateCaseDraft(row.case_draft) : null
  if (saved?.ok) return saved.value
  return buildCaseDraft(row)
}

const list = (v: string[] | undefined) => (v ?? []).join(', ')
const parseList = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** The form's fields back into a draft; `params` must be JSON (or empty). */
export function draftFromFields(
  base: Draft,
  f: { skill: string; request: string; loads: string; tools: string; avoid: string; params: string; why: string; noToolErrors: boolean },
): { ok: true; value: unknown } | { ok: false; error: string } {
  let params: unknown
  if (f.params.trim()) {
    try {
      params = JSON.parse(f.params)
    } catch {
      return { ok: false, error: 'params: not valid JSON' }
    }
  }
  const avoid = parseList(f.avoid)
  const next: Record<string, unknown> = {
    ...base.case,
    request: f.request,
    loads: parseList(f.loads),
    tools: parseList(f.tools),
  }
  delete next.params
  delete next.avoid
  delete next.why
  delete next.noToolErrors
  if (params !== undefined) next.params = params
  if (avoid.length) next.avoid = avoid
  if (f.why.trim()) next.why = f.why.trim()
  if (f.noToolErrors) next.noToolErrors = true
  return { ok: true, value: { skill: f.skill.trim(), case: next } }
}

export function CaseEditor({
  row,
  busy,
  onCancel,
  onSave,
}: {
  row: AdminEvalCandidate
  busy: boolean
  onCancel: () => void
  onSave: (draft: Draft) => void
}) {
  const base = useMemo(() => initialDraft(row), [row])
  const [skill, setSkill] = useState(base.skill)
  const [request, setRequest] = useState(base.case.request)
  const [loads, setLoads] = useState(list(base.case.loads))
  const [tools, setTools] = useState(list(base.case.tools))
  const [avoid, setAvoid] = useState(list(base.case.avoid))
  const [params, setParams] = useState(base.case.params ? JSON.stringify(base.case.params, null, 2) : '')
  const [why, setWhy] = useState(base.case.why ?? '')
  const [noToolErrors, setNoToolErrors] = useState(base.case.noToolErrors === true)
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    const built = draftFromFields(base, { skill, request, loads, tools, avoid, params, why, noToolErrors })
    if (!built.ok) return setError(built.error)
    const checked = validateCaseDraft(built.value)
    if (!checked.ok) return setError(checked.error)
    setError(null)
    onSave(checked.value)
  }

  const id = (name: string) => `case-${row.id}-${name}`
  return (
    <form
      aria-label="Promote to an eval case"
      className="space-y-3 rounded-xl border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Skill slug" htmlFor={id('skill')}>
          <Input id={id('skill')} value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="instructions" />
        </Field>
        <div className="flex items-end gap-2 pb-1.5">
          <Switch id={id('no-tool-errors')} checked={noToolErrors} onCheckedChange={setNoToolErrors} />
          <Label htmlFor={id('no-tool-errors')} className="text-sm">No tool errors</Label>
        </div>
      </div>
      <Field label="Request" htmlFor={id('request')}>
        <Textarea id={id('request')} value={request} rows={3} onChange={(e) => setRequest(e.target.value)} placeholder="What the person types" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Loads (in order)" htmlFor={id('loads')}>
          <Input id={id('loads')} value={loads} onChange={(e) => setLoads(e.target.value)} placeholder="skill-a, skill-b" />
        </Field>
        <Field label="Tools (in order)" htmlFor={id('tools')}>
          <Input id={id('tools')} value={tools} onChange={(e) => setTools(e.target.value)} placeholder="list_actions" />
        </Field>
        <Field label="Avoid" htmlFor={id('avoid')}>
          <Input id={id('avoid')} value={avoid} onChange={(e) => setAvoid(e.target.value)} placeholder="delete_action" />
        </Field>
      </div>
      <Field label="Params (JSON, per tool)" htmlFor={id('params')}>
        <Textarea
          id={id('params')}
          value={params}
          rows={4}
          className="font-mono text-xs"
          onChange={(e) => setParams(e.target.value)}
          placeholder='{ "list_actions": { "status": "todo" } }'
        />
      </Field>
      <Field label="Why" htmlFor={id('why')}>
        <Textarea id={id('why')} value={why} rows={2} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Promote'}
        </Button>
      </div>
    </form>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}
