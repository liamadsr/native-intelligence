'use client'

/**
 * Settings › Import (docs/plans/imports.md): bring tasks in from a CSV, issues
 * from Linear, pages and databases from a Notion export. Every import is
 * previewed first, runs in the background with its progress here and in the
 * work ledger, and can be undone as a whole.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, FileSpreadsheet, FileText, Folder, Info, ListTodo, Loader2, Table2, Undo2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { TASK_FIELDS, type TaskField } from '@/lib/imports/tasks/columns'
import type { ImportView, TreeNode } from '@/lib/imports/preview'

type Team = { id: string; name: string; key: string | null }
type Overview = { imports: ImportView[]; teams: Team[]; linear: { connected: boolean; mine: boolean } }
type Step = { kind: 'home' } | { kind: 'csv' } | { kind: 'linear' } | { kind: 'notion' } | { kind: 'preview'; id: string }

const FIELD_LABEL: Record<TaskField, string> = {
  title: 'Title',
  description: 'Description',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  due_date: 'Due date',
  project: 'Project',
  labels: 'Labels',
  skip: 'Don’t import',
}

const SOURCE_LABEL: Record<ImportView['source'], string> = { task_csv: 'Task CSV', linear: 'Linear', notion: 'Notion' }

const STATUS_LABEL: Record<ImportView['status'], string> = {
  staged: 'Ready to import',
  running: 'Importing…',
  done: 'Imported',
  failed: 'Stopped',
  undoing: 'Undoing…',
  undone: 'Undone',
  discarded: 'Discarded',
}

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring'

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error || `Something went wrong (${res.status}).`
}

export function ImportSettingsView() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'home' })

  const load = useCallback(async () => {
    const res = await fetch('/api/account/imports', { cache: 'no-store' })
    if (res.ok) setOverview((await res.json()) as Overview)
    else toast.error(await readError(res))
  }, [])

  useEffect(() => {
    void load()
    // A link from the assistant (?open=<id>) opens that import's preview.
    const id = new URLSearchParams(window.location.search).get('open')
    if (id && /^[0-9a-f-]{36}$/i.test(id)) setStep({ kind: 'preview', id })
  }, [load])

  const open = (id: string) => setStep({ kind: 'preview', id })
  const home = () => {
    setStep({ kind: 'home' })
    void load()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        {step.kind !== 'home' && (
          <button type="button" onClick={home} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Imports
          </button>
        )}
        {step.kind === 'home' && <Home overview={overview} onPick={(kind) => setStep({ kind })} onOpen={open} onChanged={load} />}
        {step.kind === 'csv' && <CsvStep teams={overview?.teams ?? []} onStaged={open} />}
        {step.kind === 'linear' && <LinearStep onStaged={open} />}
        {step.kind === 'notion' && <NotionStep onStaged={open} />}
        {step.kind === 'preview' && <PreviewStep id={step.id} onDone={home} />}
      </div>
    </div>
  )
}

// ── Home ─────────────────────────────────────────────────────────────────────

function Home({ overview, onPick, onOpen, onChanged }: { overview: Overview | null; onPick: (k: 'csv' | 'linear' | 'notion') => void; onOpen: (id: string) => void; onChanged: () => void }) {
  if (!overview) {
    return (
      <div>
        <Skeleton className="h-8 w-48" />
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    )
  }
  const linearHint = !overview.linear.connected ? 'Connect Linear in Connectors first.' : !overview.linear.mine ? 'Only the person who connected Linear can import from it.' : null
  return (
    <div>
      <h1 className="text-2xl font-bold">Import</h1>
      <p className="mt-1 text-sm text-muted-foreground">Bring work in from other tools. You see a preview before anything is made, and you can undo an import as a whole.</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <SourceCard icon={FileSpreadsheet} title="Tasks from a CSV" text="A spreadsheet of tasks: map its columns to title, status, assignee and more." onClick={() => onPick('csv')} />
        <SourceCard icon={ListTodo} title="Linear" text="Issues, with their projects, statuses, labels and assignees." onClick={() => onPick('linear')} disabled={!!linearHint} hint={linearHint} />
        <SourceCard icon={FileText} title="Notion" text="Upload Notion’s Markdown & CSV export: pages, databases and images." onClick={() => onPick('notion')} />
      </div>
      <h2 className="mt-10 text-sm font-semibold">Your imports</h2>
      {overview.imports.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing imported yet.</p>
      ) : (
        <ul className="mt-2 divide-y rounded-md border">
          {overview.imports.map((imp) => (
            <ImportRow key={imp.id} imp={imp} onOpen={() => onOpen(imp.id)} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  )
}

function SourceCard({ icon: Icon, title, text, onClick, disabled, hint }: { icon: typeof Upload; title: string; text: string; onClick: () => void; disabled?: boolean; hint?: string | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn('flex flex-col items-start rounded-lg border p-4 text-left transition-colors', disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted/50')}
    >
      <Icon className="h-5 w-5 text-muted-foreground" />
      <span className="mt-2 text-sm font-medium">{title}</span>
      <span className="mt-1 text-xs text-muted-foreground">{hint ?? text}</span>
    </button>
  )
}

function ImportRow({ imp, onOpen, onChanged }: { imp: ImportView; onOpen: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const undo = async () => {
    if (!window.confirm('Undo this import? What it made is removed (documents and tables go to Archive). Anything changed since is kept.')) return
    setBusy(true)
    const res = await fetch(`/api/account/imports/${imp.id}/undo`, { method: 'POST' })
    setBusy(false)
    if (!res.ok) return toast.error(await readError(res))
    toast.success('Undoing the import…')
    onOpen()
  }
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="truncate font-medium hover:underline">
          {imp.label || SOURCE_LABEL[imp.source]}
        </button>
        <div className="truncate text-xs text-muted-foreground">
          {SOURCE_LABEL[imp.source]} · {STATUS_LABEL[imp.status]} · {new Date(imp.created_at).toLocaleDateString()}
          {imp.summary ? ` · ${imp.summary}` : ''}
        </div>
      </div>
      {(imp.status === 'done' || imp.status === 'failed') && (
        <Button variant="outline" size="sm" onClick={undo} disabled={busy}>
          <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Undo
        </Button>
      )}
      {imp.status === 'staged' && (
        <Button variant="ghost" size="sm" onClick={async () => {
          const res = await fetch(`/api/account/imports/${imp.id}`, { method: 'DELETE' })
          if (!res.ok) return toast.error(await readError(res))
          onChanged()
        }}>
          Discard
        </Button>
      )}
    </li>
  )
}

// ── Task CSV ─────────────────────────────────────────────────────────────────

type SheetInfo = { file_name: string; headers: string[]; mapping: TaskField[]; samples: string[][]; rows: number; over: number }

function CsvStep({ teams, onStaged }: { teams: Team[]; onStaged: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [sheet, setSheet] = useState<SheetInfo | null>(null)
  const [mapping, setMapping] = useState<TaskField[]>([])
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  const read = async (f: File) => {
    setFile(f)
    setBusy(true)
    const body = new FormData()
    body.append('file', f)
    const res = await fetch('/api/account/imports/read', { method: 'POST', body })
    setBusy(false)
    if (!res.ok) return toast.error(await readError(res))
    const info = (await res.json()) as SheetInfo
    setSheet(info)
    setMapping(info.mapping)
  }

  const stage = async () => {
    if (!file || !sheet) return
    setBusy(true)
    const body = new FormData()
    body.append('source', 'task_csv')
    body.append('file', file)
    body.append('mapping', JSON.stringify(mapping))
    body.append('team_id', teamId)
    const res = await fetch('/api/account/imports/stage', { method: 'POST', body })
    setBusy(false)
    if (!res.ok) return toast.error(await readError(res))
    onStaged(((await res.json()) as { import: ImportView }).import.id)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Tasks from a CSV</h1>
      <p className="mt-1 text-sm text-muted-foreground">A .csv or .xlsx with a header row, up to 5 MB and 5,000 rows.</p>
      <FilePicker accept=".csv,.tsv,.xlsx" file={file} onFile={read} busy={busy && !sheet} />
      {sheet && (
        <>
          <h2 className="mt-8 text-sm font-semibold">Map the columns</h2>
          <p className="mt-1 text-xs text-muted-foreground">{sheet.rows.toLocaleString()} rows{sheet.over ? `; only the first 5,000 are imported` : ''}.</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Column</th>
                <th className="py-1.5 pr-3 font-medium">Sample</th>
                <th className="py-1.5 font-medium">Goes to</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sheet.headers.map((h, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-3 font-medium">{h || `Column ${i + 1}`}</td>
                  <td className="max-w-[16rem] truncate py-1.5 pr-3 text-muted-foreground">{sheet.samples[i]?.join(' · ') || '—'}</td>
                  <td className="py-1.5">
                    <select
                      aria-label={`Field for ${h || `column ${i + 1}`}`}
                      className={selectClass}
                      value={mapping[i] ?? 'skip'}
                      onChange={(e) => setMapping((m) => m.map((f, k) => (k === i ? (e.target.value as TaskField) : f)))}
                    >
                      {TASK_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABEL[f]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-6 flex items-center gap-3">
            <label className="text-sm">
              Team{' '}
              <select aria-label="Team" className={cn(selectClass, 'ml-1')} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <Button className="ml-auto" onClick={stage} disabled={busy || !teamId || !mapping.includes('title')}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Preview
            </Button>
          </div>
          {!mapping.includes('title') && <p className="mt-2 text-xs text-destructive">Choose the column that holds each task’s title.</p>}
        </>
      )}
    </div>
  )
}

function FilePicker({ accept, file, onFile, busy }: { accept: string; file: File | null; onFile: (f: File) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="mt-5 flex items-center gap-3">
      <input ref={input} type="file" accept={accept} className="hidden" data-testid="import-file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
        {file ? 'Choose another file' : 'Choose a file'}
      </Button>
      {file && <span className="truncate text-sm text-muted-foreground">{file.name}</span>}
    </div>
  )
}

// ── Linear ───────────────────────────────────────────────────────────────────

function LinearStep({ onStaged }: { onStaged: (id: string) => void }) {
  const [data, setData] = useState<{ linear: Array<{ id: string; key: string; name: string }>; teams: Team[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [includeClosed, setIncludeClosed] = useState(false)
  const [createStates, setCreateStates] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/account/imports/linear', { cache: 'no-store' })
      if (!res.ok) return setError(await readError(res))
      setData(await res.json())
    })()
  }, [])

  const stage = async () => {
    setBusy(true)
    const res = await fetch('/api/account/imports/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'linear', teams: Object.entries(picked).map(([linear_team_id, team_id]) => ({ linear_team_id, team_id })), include_closed: includeClosed, create_states: createStates }),
    })
    setBusy(false)
    if (!res.ok) return toast.error(await readError(res))
    onStaged(((await res.json()) as { import: ImportView }).import.id)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Import from Linear</h1>
      <p className="mt-1 text-sm text-muted-foreground">Issues come in with their projects, statuses, labels, parents and due dates. Assignees match people already in this workspace by email; anyone else stays unassigned.</p>
      {error && <p className="mt-6 text-sm text-destructive">{error}</p>}
      {!data && !error && <Skeleton className="mt-6 h-32" />}
      {data && (
        <>
          <ul className="mt-6 divide-y rounded-md border">
            {data.linear.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Import ${t.name}`}
                  checked={t.id in picked}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = { ...p }
                      if (e.target.checked) next[t.id] = data.teams.find((o) => o.name.toLowerCase() === t.name.toLowerCase())?.id ?? data.teams[0]?.id ?? ''
                      else delete next[t.id]
                      return next
                    })
                  }
                />
                <span className="flex-1">
                  {t.name} <span className="text-muted-foreground">({t.key})</span>
                </span>
                {t.id in picked && (
                  <label className="text-xs text-muted-foreground">
                    into{' '}
                    <select aria-label={`Team for ${t.name}`} className={selectClass} value={picked[t.id]} onChange={(e) => setPicked((p) => ({ ...p, [t.id]: e.target.value }))}>
                      {data.teams.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} /> Include completed and canceled issues
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={createStates} onChange={(e) => setCreateStates(e.target.checked)} /> Add Linear statuses our team doesn’t have (otherwise they fold into one of the same kind)
          </label>
          <div className="mt-6 flex">
            <Button className="ml-auto" onClick={stage} disabled={busy || !Object.keys(picked).length}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Preview
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Notion ───────────────────────────────────────────────────────────────────

function NotionStep({ onStaged }: { onStaged: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace')
  const [busy, setBusy] = useState(false)

  const stage = async () => {
    if (!file) return
    setBusy(true)
    const body = new FormData()
    body.append('source', 'notion')
    body.append('file', file)
    body.append('visibility', visibility)
    const res = await fetch('/api/account/imports/stage', { method: 'POST', body })
    setBusy(false)
    if (!res.ok) return toast.error(await readError(res))
    onStaged(((await res.json()) as { import: ImportView }).import.id)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Import from Notion</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        In Notion, open Settings › Export, choose “Markdown &amp; CSV” and include subpages, then upload the .zip (up to 50 MB). Pages become documents, nested pages become folders in Drive, databases become tables, and links between pages are kept.
      </p>
      <FilePicker accept=".zip" file={file} onFile={setFile} busy={false} />
      <fieldset className="mt-6 space-y-2 text-sm">
        <legend className="text-sm font-semibold">Who can see what comes in</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="visibility" checked={visibility === 'workspace'} onChange={() => setVisibility('workspace')} /> Everyone in the workspace
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Only me
        </label>
      </fieldset>
      <div className="mt-6 flex">
        <Button className="ml-auto" onClick={stage} disabled={busy || !file}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Preview
        </Button>
      </div>
    </div>
  )
}

// ── Preview and progress ─────────────────────────────────────────────────────

function PreviewStep({ id, onDone }: { id: string; onDone: () => void }) {
  const [view, setView] = useState<ImportView | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/account/imports/${id}`, { cache: 'no-store' })
    if (res.ok) setView(((await res.json()) as { import: ImportView }).import)
    else toast.error(await readError(res))
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const live = view?.status === 'running' || view?.status === 'undoing'
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(), 1500)
    return () => clearInterval(t)
  }, [live, load])

  const act = async (what: 'apply' | 'undo' | 'discard') => {
    if (what === 'undo' && !window.confirm('Undo this import? What it made is removed (documents and tables go to Archive). Anything changed since is kept.')) return
    setBusy(true)
    const res = what === 'discard' ? await fetch(`/api/account/imports/${id}`, { method: 'DELETE' }) : await fetch(`/api/account/imports/${id}/${what}`, { method: 'POST' })
    setBusy(false)
    if (!res.ok) return toast.error(await readError(res))
    if (what === 'discard') return onDone()
    await load()
  }

  if (!view) return <Skeleton className="h-64" />
  const p = view.progress
  const pct = p.total ? Math.round(((p.created + p.matched + p.failed) / p.total) * 100) : 0
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold">{view.label || SOURCE_LABEL[view.source]}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {SOURCE_LABEL[view.source]} · {STATUS_LABEL[view.status]}
          </p>
        </div>
        {view.status === 'staged' && (
          <>
            <Button variant="ghost" onClick={() => act('discard')} disabled={busy}>
              Discard
            </Button>
            <Button onClick={() => act('apply')} disabled={busy}>
              <Check className="mr-1.5 h-3.5 w-3.5" /> Import
            </Button>
          </>
        )}
        {view.status === 'failed' && (
          <Button onClick={() => act('apply')} disabled={busy}>
            Carry on
          </Button>
        )}
        {(view.status === 'done' || view.status === 'failed') && (
          <Button variant="outline" onClick={() => act('undo')} disabled={busy}>
            <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Undo
          </Button>
        )}
      </div>

      {live && (
        <div className="mt-6">
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${view.status === 'running' ? pct : 50}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{view.status === 'running' ? `${pct}%` : 'Undoing…'} · you can leave this page; it carries on.</p>
        </div>
      )}
      {view.summary && <p className="mt-6 rounded-md border bg-muted/30 px-3 py-2 text-sm">{view.summary}</p>}
      {view.error && <p className="mt-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{view.error}</p>}

      <Counts view={view} />
      {view.notes.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {view.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              {n.level === 'warn' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      {view.tasks && <TaskTable view={view} />}
      {view.tree && <Tree nodes={view.tree} />}
    </div>
  )
}

function Counts({ view }: { view: ImportView }) {
  const c = view.counts
  const parts: string[] = []
  const add = (n: number | undefined, one: string, many: string) => n && parts.push(`${n.toLocaleString()} ${n === 1 ? one : many}`)
  add(c.action, 'task', 'tasks')
  add(c.document, 'document', 'documents')
  add(c.data_table, 'table', 'tables')
  add(c.drive_folder, 'folder', 'folders')
  add(c.asset, 'file', 'files')
  add(c.label, 'new label', 'new labels')
  add(c.project, 'new project', 'new projects')
  add(c.workflow_state, 'new status', 'new statuses')
  if (!parts.length) return null
  return <p className="mt-6 text-sm font-medium">{view.status === 'staged' ? 'Will make' : 'Planned'}: {parts.join(', ')}</p>
}

function TaskTable({ view }: { view: ImportView }) {
  const tasks = view.tasks ?? []
  if (!tasks.length) return null
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">From</th>
            <th className="py-1.5 pr-3 font-medium">Title</th>
            <th className="py-1.5 pr-3 font-medium">Status</th>
            <th className="py-1.5 pr-3 font-medium">Priority</th>
            <th className="py-1.5 pr-3 font-medium">Assignee</th>
            <th className="py-1.5 pr-3 font-medium">Due</th>
            <th className="py-1.5 pr-3 font-medium">Project</th>
            <th className="py-1.5 font-medium">Labels</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {tasks.map((t, i) => (
            <tr key={i} className={cn(t.outcome === 'failed' && 'text-destructive')}>
              <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{t.source}</td>
              <td className="max-w-[18rem] truncate py-1.5 pr-3">{t.title}</td>
              <td className="py-1.5 pr-3">{t.status ?? '—'}</td>
              <td className="py-1.5 pr-3 capitalize">{t.priority === 'none' ? '—' : t.priority}</td>
              <td className="py-1.5 pr-3">{t.assignee ?? '—'}</td>
              <td className="whitespace-nowrap py-1.5 pr-3">{t.due_date ?? '—'}</td>
              <td className="py-1.5 pr-3">{t.project ?? '—'}</td>
              <td className="py-1.5">{t.labels.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(view.counts.action ?? 0) > tasks.length && <p className="mt-2 text-xs text-muted-foreground">The first {tasks.length} of {(view.counts.action ?? 0).toLocaleString()}.</p>}
    </div>
  )
}

function Tree({ nodes }: { nodes: TreeNode[] }) {
  const children = useMemo(() => {
    const m = new Map<string | null, TreeNode[]>()
    for (const n of nodes) m.set(n.parent, [...(m.get(n.parent) ?? []), n])
    return m
  }, [nodes])
  const render = (parent: string | null, depth: number): React.ReactNode =>
    (children.get(parent) ?? []).map((n) => (
      <div key={n.ref}>
        <div className="flex items-center gap-2 py-0.5 text-sm" style={{ paddingLeft: depth * 16 }}>
          {n.kind === 'drive_folder' ? <Folder className="h-3.5 w-3.5 text-muted-foreground" /> : n.kind === 'data_table' ? <Table2 className="h-3.5 w-3.5 text-muted-foreground" /> : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className={cn(n.outcome === 'failed' && 'text-destructive')}>{n.name}</span>
          {n.kind === 'data_table' && <span className="text-xs text-muted-foreground">{n.rows?.toLocaleString()} rows · {n.columns?.join(', ')}</span>}
        </div>
        {n.kind === 'drive_folder' && render(n.ref, depth + 1)}
      </div>
    ))
  return <div className="mt-6 rounded-md border p-3">{render(null, 0)}</div>
}
