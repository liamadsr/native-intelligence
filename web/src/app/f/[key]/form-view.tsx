'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SchedulingNotice } from '@/components/scheduling/scheduling-shell'
import type { PublicFormField, PublicFormShape } from '@/lib/forms/public'
import { solveFormChallenge } from '@/lib/forms/solve'

export type FormPageState =
  | { kind: 'open'; link: string; invite: string | null; shape: PublicFormShape }
  | { kind: 'closed' }
  | { kind: 'not_member' }
  | { kind: 'invite_needed' }
  | { kind: 'unavailable' }

const LINES: Record<Exclude<FormPageState['kind'], 'open'>, string> = {
  closed: 'This form is closed.',
  not_member: 'This form is for members of its workspace.',
  invite_needed: 'This link has been used or has expired.',
  unavailable: "This form can't be opened right now. Try again in a little while.",
}

const THANKS = 'Thanks. We got it.'
const MB = 1024 * 1024
const FAILED = 'Something went wrong. Try again.'
/** The posted names a person's name is asked by: the browser fills them in. */
const NAME_NAMES = new Set(['name', 'full_name', 'your_name'])

type Value = string | boolean | string[]

/** One card on the page's background, the line under it: the booking page's frame. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-4 text-foreground sm:p-6 lg:p-8">
      <Card className="w-full max-w-lg">{children}</Card>
      <p className="text-xs text-muted-foreground">Forms by Native Intelligence</p>
    </div>
  )
}

export function FormView({ state }: { state: FormPageState }) {
  if (state.kind !== 'open') {
    return (
      <Shell>
        <CardHeader>
          <p className="text-sm" data-form-line={state.kind}>
            {LINES[state.kind]}
          </p>
        </CardHeader>
      </Shell>
    )
  }
  return <OpenForm link={state.link} invite={state.invite} shape={state.shape} />
}

/**
 * Why these files can't be sent, or null: too many, too large, or not a kind
 * the form takes (by name). The server checks each again, by its bytes too:
 * this only spares a person the round trip.
 */
export function filesProblem(field: PublicFormField, files: readonly File[]): string | null {
  const max = field.max_files ?? 5
  if (files.length > max) return `Choose at most ${max} files.`
  const kinds = new Set((field.accept ?? '').split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean))
  for (const file of files) {
    const dot = file.name.lastIndexOf('.')
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
    if (kinds.size && !kinds.has(ext)) return `"${file.name}" isn't a kind of file this form takes.`
    if (file.size === 0) return `"${file.name}" is empty.`
    if (field.max_bytes && file.size > field.max_bytes) return `"${file.name}" is larger than ${Math.round(field.max_bytes / MB)} MB.`
  }
  return null
}

/** What the post carries for one field: nothing for an empty one. */
function postedValue(field: PublicFormField, value: Value | undefined): unknown {
  if (value === undefined) return undefined
  if (field.type === 'checkbox') return value === true ? true : undefined
  if (Array.isArray(value)) return value.length ? value : undefined
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  if (field.type === 'number' || field.type === 'currency') {
    const n = Number(text)
    return Number.isFinite(n) ? n : text
  }
  return text
}

/**
 * The form itself. On its own page (/f/<key>) it posts to the form's intake
 * and thanks the person. A booking link's form (booking insights phase 4)
 * gives `endpoint` (its own route, which runs the same intake, and
 * `${endpoint}/challenge`), `onSent` (what the answer means is the link's to
 * say) and `framed: false` (it sits inside the booking page's card).
 */
export function OpenForm({
  link,
  invite,
  shape,
  endpoint,
  onSent,
  framed = true,
}: {
  link: string
  invite: string | null
  shape: PublicFormShape
  endpoint?: string
  onSent?: (data: Record<string, unknown>) => void
  framed?: boolean
}) {
  const Frame = framed ? Shell : Bare
  const [values, setValues] = useState<Record<string, Value>>({})
  const [files, setFiles] = useState<File[]>([])
  const fileField = shape.fields.find((f) => f.type === 'file') ?? null
  const fileError = fileField ? filesProblem(fileField, files) : null
  const [gotcha, setGotcha] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)
  // One id per page: a post sent twice (a double press, a retry) is stored once.
  const [submissionId] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)))
  const challenge = useRef<Promise<{ token: string; answer: string }> | null>(null)
  const base = endpoint ?? `/api/intake/forms/${encodeURIComponent(link)}`
  const query = invite ? `?i=${encodeURIComponent(invite)}` : ''

  // The challenge is fetched and worked as the page loads, so it is ready (and old enough) by the time a person presses Send.
  const startChallenge = () => {
    const run = (async () => {
      const res = await fetch(`${base}/challenge${query}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const { token, difficulty } = (await res.json()) as { token: string; difficulty: number }
      return { token, answer: await solveFormChallenge(token, difficulty) }
    })()
    run.catch(() => {})
    challenge.current = run
  }
  useEffect(() => {
    if (shape.bot_check) startChallenge()
    // Once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (name: string, value: Value) => setValues((v) => ({ ...v, [name]: value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (fileError) return setError(fileError)
    if (fileField?.required && !files.length) return setError(`${fileField.label} is required.`)
    setBusy(true)
    setError('')
    const body: Record<string, unknown> = { submission_id: submissionId, _gotcha: gotcha }
    for (const field of shape.fields) {
      if (field.type === 'file') continue
      const v = postedValue(field, values[field.name])
      if (v !== undefined) body[field.name] = v
    }
    if (invite) body._invite = invite
    try {
      if (shape.bot_check) {
        if (!challenge.current) startChallenge()
        let solved: { token: string; answer: string }
        try {
          solved = await challenge.current!
        } catch {
          // One more go: the first fetch may have failed on a flaky connection.
          startChallenge()
          solved = await challenge.current!
        }
        body._challenge = solved.token
        body._answer = solved.answer
      }
      // A form that takes files posts them with its fields in one multipart body; any other posts JSON.
      const res = fileField
        ? await fetch(base, { method: 'POST', body: multipartOf(body, fileField.name, files) })
        : await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; thanks?: string; error?: string; code?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? FAILED)
        // A stale or used challenge: a fresh one is worked now, for the next press.
        if (data.code === 'CHALLENGE_FAILED' && shape.bot_check) startChallenge()
        setBusy(false)
        return
      }
      if (onSent) {
        setBusy(false)
        return onSent(data as Record<string, unknown>)
      }
      setDone(shape.thanks ?? data.thanks ?? THANKS)
    } catch {
      setError(FAILED)
    }
    setBusy(false)
  }

  if (done !== null) {
    return (
      <Frame>
        <CardHeader>
          <p className="text-sm" data-form-done>
            {done}
          </p>
        </CardHeader>
      </Frame>
    )
  }

  return (
    <Frame>
      <CardHeader>
        <CardTitle className="text-2xl">{shape.name}</CardTitle>
        {shape.description && <CardDescription className="whitespace-pre-line">{shape.description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" data-form>
          {shape.fields.map((field, i) =>
            field.type === 'file' ? (
              <FilesInput key={field.name} id={`form-field-${i}`} field={field} files={files} problem={fileError} onChange={setFiles} />
            ) : (
              <FieldInput key={field.name} id={`form-field-${i}`} field={field} value={values[field.name]} onChange={(v) => set(field.name, v)} />
            ),
          )}
          {/* A field people never see: bots fill it. */}
          <input type="text" name="_gotcha" value={gotcha} onChange={(e) => setGotcha(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
          {error && <SchedulingNotice data-form-error="">{error}</SchedulingNotice>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Sending…' : (shape.submit_label ?? 'Send')}
          </Button>
        </form>
      </CardContent>
    </Frame>
  )
}

/** No frame: the form inside someone else's card. */
function Bare({ children }: { children: ReactNode }) {
  return <div data-form-bare="">{children}</div>
}

/** The post as one multipart body: each value as text (a list as one part per item), then the files under `name`. */
function multipartOf(body: Record<string, unknown>, name: string, files: readonly File[]): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) form.append(key, String(item))
    else form.append(key, String(value))
  }
  for (const file of files) form.append(name, file, file.name)
  return form
}

/** The files field: a file input, the chosen files listed, and why they can't be sent. */
function FilesInput({ id, field, files, problem, onChange }: { id: string; field: PublicFormField; files: readonly File[]; problem: string | null; onChange: (files: File[]) => void }) {
  const max = field.max_files ?? 5
  const mb = field.max_bytes ? Math.round(field.max_bytes / MB) : null
  return (
    <div className="space-y-1.5" data-form-files="">
      <FieldLabel htmlFor={id} field={field} />
      <Input id={id} name={field.name} type="file" multiple={max > 1} accept={field.accept} onChange={(e) => onChange(Array.from(e.target.files ?? []))} />
      <p className="text-xs text-muted-foreground">
        Up to {max} {max === 1 ? 'file' : 'files'}
        {mb ? `, ${mb} MB each` : ''}: photos, PDFs, text, and Word, Excel or PowerPoint files.
      </p>
      {files.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground" data-form-files-chosen="">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="truncate">
              {f.name}
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="text-xs text-destructive" data-form-files-problem="">
          {problem}
        </p>
      )}
    </div>
  )
}

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-colors focus-visible:outline-none focus-visible:border-foreground/30 md:text-sm'
const boxClass = 'size-4 shrink-0 rounded border-input accent-foreground'

function FieldLabel({ htmlFor, field }: { htmlFor?: string; field: PublicFormField }) {
  return (
    <Label htmlFor={htmlFor}>
      {field.label}
      {field.type === 'currency' && field.currency ? ` (${field.currency})` : ''}
      {field.required && (
        <span aria-hidden="true" className="text-muted-foreground">
          {' '}
          *
        </span>
      )}
    </Label>
  )
}

function FieldInput({ id, field, value, onChange }: { id: string; field: PublicFormField; value: Value | undefined; onChange: (v: Value) => void }) {
  const text = typeof value === 'string' ? value : ''
  const common = { id, name: field.name, required: field.required }

  if (field.type === 'checkbox') {
    return (
      <div className="flex items-center gap-2">
        <input {...common} type="checkbox" className={boxClass} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <FieldLabel htmlFor={id} field={field} />
      </div>
    )
  }

  if (field.type === 'multi_select') {
    const chosen = Array.isArray(value) ? value : []
    return (
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium leading-none">
          {field.label}
          {field.required && (
            <span aria-hidden="true" className="text-muted-foreground">
              {' '}
              *
            </span>
          )}
        </legend>
        {(field.options ?? []).map((option, j) => (
          <label key={option} htmlFor={`${id}-${j}`} className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-${j}`}
              type="checkbox"
              name={field.name}
              value={option}
              className={boxClass}
              checked={chosen.includes(option)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, option] : chosen.filter((o) => o !== option))}
            />
            {option}
          </label>
        ))}
      </fieldset>
    )
  }

  let control: ReactNode
  if (field.type === 'select') {
    control = (
      <select {...common} className={selectClass} value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  } else if (field.type === 'text' && field.long) {
    control = <Textarea {...common} rows={4} maxLength={5000} value={text} onChange={(e) => onChange(e.target.value)} />
  } else {
    const typed: Record<string, React.InputHTMLAttributes<HTMLInputElement>> = {
      text: { type: 'text', maxLength: 5000, autoComplete: NAME_NAMES.has(field.name) ? 'name' : undefined },
      number: { type: 'number', inputMode: 'decimal', step: 'any' },
      currency: { type: 'number', inputMode: 'decimal', step: '0.01', min: 0 },
      date: { type: 'date' },
      url: { type: 'url', inputMode: 'url', placeholder: 'https://' },
      email: { type: 'email', inputMode: 'email', autoComplete: 'email' },
      phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel' },
    }
    control = <Input {...common} {...(typed[field.type] ?? typed.text)} value={text} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id} field={field} />
      {control}
    </div>
  )
}
