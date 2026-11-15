'use client'

/**
 * A table's forms (forms phase 3): a link anyone can fill in, each
 * submission one new row of this table. A side panel, like the row panel and
 * History: make a form (its fields, who can fill it in), then change it, and
 * every change is saved at once. On a pipeline each submission is a new deal
 * (in its first open stage). A form may also take files (its Files field,
 * off by default), which keeps its bot check on.
 *
 * A form's links hold its secret, which is never stored: the server shows
 * them once, when a link is made (a new form, or Make a new link). They stay
 * here while the panel is open; after that the panel only knows how the link
 * starts, and offers a new one. Personal links (an invited form) likewise.
 *
 * The REST contract is src/lib/forms/manage.ts.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Paperclip, Plus, X, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/work/presentation'
import { FORM_FILES_KEY, FORM_LIMITS, FORM_TITLE_KEY, isFormColumn, type FormAccess } from '@/lib/forms/types'
import type { formForApi } from '@/lib/forms/manage'
import { formPresetFor } from '@/lib/forms/presets'
import type { DataColumn, DataColumnType } from '@/lib/tables/types'
import { TYPE_ICONS } from './cells'
import { fieldClass } from './column-forms'

/** A form as the server answers it (never its links). */
export type ApiForm = ReturnType<typeof formForApi>
type FieldDraft = { key: string; label: string; required: boolean }
type Links = { url: string; page_url: string; embed?: string }
type Invite = { id: string; label: string | null; url: string; expires_at: string }
type Patch = (body: Record<string, unknown>, optimistic?: Partial<ApiForm>) => Promise<boolean>

/** One thing a form may fill: the row's name, a column a stranger may fill, or the files it takes. */
interface Choice {
  key: string
  label: string
  type: DataColumnType | 'file'
}

const iconOf = (type: Choice['type']): LucideIcon => (type === 'file' ? Paperclip : TYPE_ICONS[type])

/** What the bot check's switch says while a form takes files: it stays on. */
export const FILES_KEEP_BOT_CHECK = 'On while the form takes files'

export const ACCESS_CHOICES: ReadonlyArray<{ value: FormAccess; label: string }> = [
  { value: 'public', label: 'Anyone with the link' },
  { value: 'invited', label: 'Only people I send a personal link to' },
  { value: 'members', label: 'Only members of this workspace' },
]

const COPY_NOW = 'Copy it now: it won’t be shown again. You can always make a new link.'

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error || 'Something went wrong. Try again.')
  return json
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Try again.')

/**
 * What a form on these columns may fill: the row's name first, then the
 * columns a form may fill in order (never a pipeline's Stage or its other
 * system choices: isFormColumn), then the files. Pure.
 */
export function formChoices(columns: readonly DataColumn[]): Choice[] {
  return [
    { key: FORM_TITLE_KEY, label: 'Name', type: 'text' },
    ...columns.filter((c) => isFormColumn(c)).map((c) => ({ key: c.key, label: c.label, type: c.field_type })),
    { key: FORM_FILES_KEY, label: 'Files', type: 'file' },
  ]
}

/**
 * A new form's fields: the table's ready-made set when it has one (a Quote
 * requests table: src/lib/forms/presets.ts), else the row's name and every
 * email and phone column. Never the files: they are off until asked. Pure.
 */
export function defaultFields(choices: readonly Choice[], columns: readonly DataColumn[] = []): FieldDraft[] {
  const preset = formPresetFor(columns)
  const keys = new Set(choices.map((c) => c.key))
  if (preset) return preset.fields.filter((f) => keys.has(f.key)).map((f) => ({ key: f.key, label: f.label, required: f.required }))
  return choices.filter((c) => c.key === FORM_TITLE_KEY || c.type === 'email' || c.type === 'phone').map((c) => ({ key: c.key, label: c.label, required: false }))
}

/** When the last submission came, in words. Pure. */
function submittedWhen(iso: string): string {
  const t = relativeTime(iso)
  if (t === 'now') return 'just now'
  return /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`
}

export function FormsPanel({
  tableId,
  tableName,
  columns,
  pipeline = false,
  onClose,
}: {
  tableId: string
  tableName: string
  columns: readonly DataColumn[]
  /** A pipeline: each submission is a new deal. */
  pipeline?: boolean
  onClose: () => void
}) {
  const [forms, setForms] = useState<ApiForm[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 'auto': the one form, or the list of several. */
  const [screen, setScreen] = useState<'auto' | 'new' | { formId: string }>('auto')
  const [links, setLinks] = useState<Record<string, Links>>({})
  const [invites, setInvites] = useState<Record<string, Invite[]>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const pending = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const formsRef = useRef<ApiForm[] | null>(null)
  formsRef.current = forms

  useEffect(() => {
    let live = true
    send<{ forms?: ApiForm[] }>(`/api/account/tables/${encodeURIComponent(tableId)}/forms`, 'GET')
      .then((j) => live && setForms(j.forms ?? []))
      .catch((err) => live && setLoadError(messageOf(err)))
    return () => {
      live = false
    }
  }, [tableId])

  const replace = (form: ApiForm) => setForms((fs) => (fs ? fs.map((f) => (f.id === form.id ? form : f)) : fs))
  const keepLinks = (formId: string, j: Partial<Links>) => {
    if (j.url && j.page_url) setLinks((l) => ({ ...l, [formId]: { url: j.url!, page_url: j.page_url!, ...(j.embed ? { embed: j.embed } : {}) } }))
  }

  /** A change to one form, shown at once and saved in turn (one in flight); refused, it goes back and the reason shows. */
  const patchForm = useCallback((formId: string, body: Record<string, unknown>, optimistic?: Partial<ApiForm>) => {
    const before = formsRef.current?.find((f) => f.id === formId)
    if (optimistic) setForms((fs) => (fs ? fs.map((f) => (f.id === formId ? { ...f, ...optimistic } : f)) : fs))
    pending.current++
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    const run = chain.current.then(async () => {
      try {
        const j = await send<{ form: ApiForm } & Partial<Links>>(`/api/account/forms/${encodeURIComponent(formId)}`, 'PATCH', body)
        replace(j.form)
        keepLinks(formId, j)
        return true
      } catch (err) {
        if (before && optimistic) {
          const back = Object.fromEntries(Object.keys(optimistic).map((k) => [k, before[k as keyof ApiForm]])) as Partial<ApiForm>
          setForms((fs) => (fs ? fs.map((f) => (f.id === formId ? { ...f, ...back } : f)) : fs))
        }
        setSaveError(messageOf(err))
        return false
      } finally {
        pending.current--
        if (!pending.current) setSaving(false)
      }
    })
    chain.current = run
    return run.then((ok) => {
      if (ok && !pending.current) setSaved(true)
      return ok
    })
  }, [])

  const open = (next: typeof screen) => {
    setSaved(false)
    setSaveError(null)
    setScreen(next)
  }

  const current = typeof screen === 'object' ? forms?.find((f) => f.id === screen.formId) ?? null : screen === 'auto' && forms?.length === 1 ? forms[0] : null
  const making = !!forms && (screen === 'new' || forms.length === 0)
  const listing = !!forms && !making && !current && forms.length > 1

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md" data-forms-panel="">
        <SheetHeader className="space-y-1 border-b border-border py-4 pl-5 pr-12 text-left">
          <div className="flex items-center gap-2">
            {current && forms && forms.length > 1 && (
              <Button size="icon" variant="ghost" className="-ml-1 h-7 w-7" aria-label="All forms" onClick={() => open('auto')}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <SheetTitle className="min-w-0 flex-1 truncate text-base">{making ? 'New form' : listing ? 'Forms' : 'Form'}</SheetTitle>
            {forms && !making && (
              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => open('new')}>
                <Plus className="h-3.5 w-3.5" />
                New form
              </Button>
            )}
          </div>
          <SheetDescription className="text-xs">
            Each time someone fills it in, it adds {pipeline ? 'a deal' : 'a row'} to {tableName}.
          </SheetDescription>
        </SheetHeader>
        {!forms && !loadError && <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}
        {loadError && (
          <p role="alert" className="px-5 py-4 text-sm text-destructive">
            {loadError}
          </p>
        )}
        {making && (
          <NewForm
            tableId={tableId}
            tableName={tableName}
            columns={columns}
            onCancel={forms!.length > 0 ? () => open('auto') : undefined}
            onMade={(form, j) => {
              setForms((fs) => [...(fs ?? []), form])
              keepLinks(form.id, j)
              open({ formId: form.id })
            }}
          />
        )}
        {listing && (
          <ul className="divide-y divide-border px-2 py-2" data-forms-list="">
            {forms!.map((f) => (
              <li key={f.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left hover:bg-muted/50" onClick={() => open({ formId: f.id })}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{f.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{ACCESS_CHOICES.find((a) => a.value === f.access)?.label}</span>
                  </span>
                  {!f.active && <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Off</span>}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {current && (
          <FormEditor
            key={current.id}
            form={current}
            columns={columns}
            links={links[current.id]}
            invites={invites[current.id] ?? []}
            onInvited={(made) => setInvites((m) => ({ ...m, [current.id]: [...made, ...(m[current.id] ?? [])] }))}
            patch={(body, optimistic) => patchForm(current.id, body, optimistic)}
            saving={saving}
            saved={saved}
            saveError={saveError}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

/** One screen to make a form: its name, its fields, who can fill it in. */
function NewForm({
  tableId,
  tableName,
  columns,
  onCancel,
  onMade,
}: {
  tableId: string
  tableName: string
  columns: readonly DataColumn[]
  onCancel?: () => void
  onMade: (form: ApiForm, links: Partial<Links>) => void
}) {
  const choices = formChoices(columns)
  const preset = formPresetFor(columns)
  const [name, setName] = useState((preset?.name ?? tableName).slice(0, FORM_LIMITS.name))
  const [fields, setFields] = useState<FieldDraft[]>(() => defaultFields(choices, columns))
  const [access, setAccess] = useState<FormAccess>('public')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const make = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const j = await send<{ form: ApiForm } & Partial<Links>>(`/api/account/tables/${encodeURIComponent(tableId)}/forms`, 'POST', {
        name: name.trim() || tableName,
        fields: fields.map((f) => ({ key: f.key, label: f.label, required: f.required })),
        access,
        ...(preset ? { submit_label: preset.submitLabel } : {}),
      })
      onMade(j.form, j)
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 px-5 py-4" data-new-form="">
      <Section title="Name">
        <Input aria-label="Form name" className="h-8" maxLength={FORM_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
      </Section>
      <Section title="Fields">
        <FieldsEditor choices={choices} fields={fields} onChange={setFields} />
      </Section>
      <Section title="Who can fill it in">
        <AccessChoice value={access} onChange={setAccess} />
      </Section>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={busy || !fields.length} onClick={() => void make()}>
          {busy ? 'Making…' : 'Make form'}
        </Button>
      </div>
    </div>
  )
}

/** An existing form: every setting, each saved as it changes. */
function FormEditor({
  form,
  columns,
  links,
  invites,
  onInvited,
  patch,
  saving,
  saved,
  saveError,
}: {
  form: ApiForm
  columns: readonly DataColumn[]
  links?: Links
  invites: readonly Invite[]
  onInvited: (made: Invite[]) => void
  patch: Patch
  saving: boolean
  saved: boolean
  saveError: string | null
}) {
  const choices = formChoices(columns)
  const eligible = new Set(choices.map((c) => c.key))
  const live = form.fields.filter((f) => !f.gone && eligible.has(f.key)).map((f) => ({ key: f.key, label: f.label, required: f.required }))
  const stale = form.fields.filter((f) => f.gone || !eligible.has(f.key))
  const [confirming, setConfirming] = useState(false)

  const takesFiles = form.fields.some((f) => f.key === FORM_FILES_KEY)

  // The server can't take a field whose column is gone, so a save of the fields leaves those out.
  // Files need the bot check: ticking Files turns it on in the same save.
  const setFields = (next: FieldDraft[]) => {
    const kept = new Map(form.fields.map((f) => [f.key, f]))
    const types = new Map(choices.map((c) => [c.key, c.type]))
    const shown = next.map((f) => ({ post_as: f.key === FORM_FILES_KEY ? 'files' : f.key, type: types.get(f.key) ?? null, ...kept.get(f.key), ...f })) as ApiForm['fields']
    const needsCheck = next.some((f) => f.key === FORM_FILES_KEY) && !form.bot_check
    void patch(needsCheck ? { fields: next, bot_check: true } : { fields: next }, needsCheck ? { fields: shown, bot_check: true } : { fields: shown })
  }

  return (
    <div className="space-y-5 px-5 py-4" data-form-editor={form.id}>
      <div className="space-y-1">
        <TextSetting label="Form name" bare value={form.name} max={FORM_LIMITS.name} required className="h-9 text-base font-medium" onCommit={(v) => void patch({ name: v }, { name: v ?? form.name })} />
        <p className="flex min-h-4 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{form.last_submission ? `Last submission ${submittedWhen(form.last_submission)}` : null}</span>
          <span className="shrink-0" aria-live="polite" data-save-state="">
            {saving ? 'Saving…' : saved ? 'Saved' : ''}
          </span>
        </p>
        {saveError && <ErrorLine>{saveError}</ErrorLine>}
      </div>

      <SwitchRow label="Taking submissions" checked={form.active} onChange={(on) => void patch({ active: on }, { active: on })} />

      <Section title="Link">
        {links ? (
          <div className="space-y-3" data-form-links="">
            <CopyField label="Share this page" value={links.page_url} />
            {form.access === 'public' && links.embed && <CopyField label="Put it on your website" value={links.embed} multiline />}
            <p className="text-xs text-muted-foreground">{COPY_NOW}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-link-starts="">
            Link starts with <span className="font-mono text-foreground">{form.link_starts}…</span>
          </p>
        )}
        {confirming ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2.5" data-new-link-confirm="">
            <p className="text-sm text-foreground">The current link stops working right away, on your website too.</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setConfirming(false)
                  void patch({ new_link: true })
                }}
              >
                Make a new link
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="w-fit" onClick={() => setConfirming(true)}>
            Make a new link
          </Button>
        )}
      </Section>

      <Section title="Fields">
        <FieldsEditor choices={choices} fields={live} stale={stale} onChange={setFields} onRemoveStale={() => setFields(live)} />
      </Section>

      <Section title="Who can fill it in">
        <AccessChoice value={form.access} onChange={(access) => void patch({ access }, { access })} />
      </Section>

      {form.access === 'invited' && form.active && <PersonalLinks formId={form.id} made={invites} onMade={onInvited} />}

      <Section title="The page">
        <TextSetting label="Description" placeholder="A few lines under the form’s name" value={form.description} max={FORM_LIMITS.description} multiline onCommit={(v) => void patch({ description: v }, { description: v })} />
        <TextSetting label="Button" placeholder="Send" value={form.submit_label} max={FORM_LIMITS.submitLabel} onCommit={(v) => void patch({ submit_label: v }, { submit_label: v })} />
        <TextSetting label="Thank-you line" placeholder="Thanks. We got it." value={form.thanks} max={FORM_LIMITS.thanks} multiline onCommit={(v) => void patch({ thanks: v }, { thanks: v })} />
      </Section>

      <SwitchRow
        label="Check for bots"
        help={takesFiles ? FILES_KEEP_BOT_CHECK : 'Turn off only if your own website’s form posts to this link'}
        checked={form.bot_check}
        disabled={takesFiles && form.bot_check}
        onChange={(on) => void patch({ bot_check: on }, { bot_check: on })}
      />

      <Developers form={form} links={links} patch={patch} />
    </div>
  )
}

/** The posting link (while it's known), the names a website posts each field by, and the websites allowed to post. */
function Developers({ form, links, patch }: { form: ApiForm; links?: Links; patch: Patch }) {
  const [open, setOpen] = useState(false)
  const live = form.fields.filter((f) => !f.gone)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-3" data-developers="">
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm font-medium text-foreground">
        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
        For developers
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-3">
        {links && (
          <div className="space-y-1">
            <CopyField label="Posting link" value={links.url} />
            <p className="text-xs text-muted-foreground">Your own website’s form can post to this link. {COPY_NOW}</p>
          </div>
        )}
        {live.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Each field is posted by this name</p>
            <ul className="space-y-0.5 text-sm">
              {live.map((f) => (
                <li key={f.key} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{f.post_as}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <OriginsEditor origins={form.allowed_origins} onChange={(next) => patch({ allowed_origins: next })} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The websites allowed to post: https addresses; none means any. */
function OriginsEditor({ origins, onChange }: { origins: readonly string[]; onChange: (next: string[]) => Promise<boolean> }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    const v = draft.trim().replace(/\/+$/, '')
    if (!v || busy) return
    if (origins.includes(v)) return setDraft('')
    setBusy(true)
    if (await onChange([...origins, v])) setDraft('')
    setBusy(false)
  }
  return (
    <div className="space-y-1.5" data-origins="">
      <p className="text-xs font-medium text-muted-foreground">Allowed websites</p>
      <p className="text-xs text-muted-foreground">Only these websites can post to the link. Leave it empty to allow any.</p>
      {origins.length > 0 && (
        <ul className="space-y-0.5">
          {origins.map((o) => (
            <li key={o} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{o}</span>
              <button type="button" aria-label={`Remove ${o}`} className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => void onChange(origins.filter((x) => x !== o))}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {origins.length < FORM_LIMITS.origins && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input aria-label="Website address" className={fieldClass} placeholder="https://yoursite.example" inputMode="url" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0" disabled={!draft.trim() || busy}>
            Add
          </Button>
        </form>
      )}
    </div>
  )
}

/** Personal links for an invited form: one per name, each shown once, with the day it stops working. */
function PersonalLinks({ formId, made, onMade }: { formId: string; made: readonly Invite[]; onMade: (made: Invite[]) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const labels = text.split('\n').map((s) => s.trim()).filter(Boolean)
  const tooMany = labels.length > FORM_LIMITS.invitesPerCall
  const make = async () => {
    if (busy || !labels.length || tooMany) return
    setBusy(true)
    setError(null)
    try {
      const j = await send<{ invites: Invite[] }>(`/api/account/forms/${encodeURIComponent(formId)}/invites`, 'POST', { invites: labels.map((label) => ({ label })) })
      onMade(j.invites ?? [])
      setText('')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Personal links">
      <div className="space-y-2" data-personal-links="">
        <p className="text-xs text-muted-foreground">Each person gets their own link, good for one submission.</p>
        <Textarea aria-label="Who the links are for" rows={3} className="text-sm" placeholder={'One name per line\nSam Rivera\nAlex Kim'} value={text} onChange={(e) => setText(e.target.value)} />
        {tooMany && <p className="text-xs text-destructive">At most {FORM_LIMITS.invitesPerCall} at a time.</p>}
        {error && <ErrorLine>{error}</ErrorLine>}
        <Button size="sm" variant="outline" className="w-fit" disabled={busy || !labels.length || tooMany} onClick={() => void make()}>
          {busy ? 'Making…' : labels.length > 1 ? `Make ${labels.length} links` : 'Make links'}
        </Button>
        {made.length > 0 && (
          <div className="space-y-3 pt-1" data-made-invites="">
            {made.map((m) => (
              <CopyField key={m.id} label={`${m.label || 'Personal link'} · stops working ${new Date(m.expires_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`} value={m.url} />
            ))}
            <p className="text-xs text-muted-foreground">Copy them now: they won’t be shown again. You can always make more.</p>
          </div>
        )}
      </div>
    </Section>
  )
}

/**
 * The fields: the ticked ones in the form's order (each with its label,
 * Required, and up and down), those whose column is gone (to remove), then
 * the rest of what may be on a form, in the table's order, to tick.
 */
function FieldsEditor({
  choices,
  fields,
  stale = [],
  onChange,
  onRemoveStale,
}: {
  choices: readonly Choice[]
  fields: readonly FieldDraft[]
  stale?: ReadonlyArray<{ key: string; label: string; gone?: boolean }>
  onChange: (next: FieldDraft[]) => void
  onRemoveStale?: () => void
}) {
  const byKey = new Map(choices.map((c) => [c.key, c]))
  const on = new Set(fields.map((f) => f.key))
  const rest = choices.filter((c) => !on.has(c.key))
  const full = fields.length >= FORM_LIMITS.fields
  const set = (i: number, patch: Partial<FieldDraft>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <ul className="space-y-1" data-form-fields="">
      {fields.map((f, i) => {
        const c = byKey.get(f.key)
        if (!c) return null
        const Icon = iconOf(c.type)
        const last = fields.length === 1
        return (
          <li key={f.key} className="flex items-center gap-1.5" data-form-field={f.key}>
            <input type="checkbox" className="shrink-0" aria-label={`On the form: ${c.label}`} checked disabled={last} title={last ? 'A form needs at least one field' : undefined} onChange={() => onChange(fields.filter((_, j) => j !== i))} />
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <LabelInput value={f.label} fallback={c.label} onCommit={(label) => set(i, { label })} />
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
            </label>
            <div className="flex shrink-0 flex-col">
              <button type="button" aria-label={`Move ${f.label} up`} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>
                <ChevronUp className="h-3 w-3" />
              </button>
              <button type="button" aria-label={`Move ${f.label} down`} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          </li>
        )
      })}
      {stale.map((s) => (
        <li key={s.key} className="flex items-center gap-2 py-1" data-gone-field={s.key}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-muted-foreground line-through">{s.label}</span>
            <span className="block text-xs text-muted-foreground">{s.gone ? 'This column was deleted' : 'This column can’t be on a form any more'}</span>
          </span>
          {onRemoveStale && (
            <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={onRemoveStale}>
              Remove
            </Button>
          )}
        </li>
      ))}
      {rest.map((c) => {
        const Icon = iconOf(c.type)
        return (
          <li key={c.key} data-form-field-off={c.key}>
            <label className={cn('flex h-8 items-center gap-1.5 text-sm text-muted-foreground', full ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
              <input type="checkbox" className="shrink-0" aria-label={`On the form: ${c.label}`} checked={false} disabled={full} onChange={() => onChange([...fields, { key: c.key, label: c.label, required: false }])} />
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

/** A field's label, saved when it loses focus; emptied, it goes back to the column's name. */
function LabelInput({ value, fallback, onCommit }: { value: string; fallback: string; onCommit: (label: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim() || fallback
    if (v !== draft) setDraft(v)
    if (v !== value) onCommit(v)
  }
  return (
    <input
      aria-label={`Label for ${fallback}`}
      className={cn(fieldClass, 'flex-1')}
      maxLength={FORM_LIMITS.label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** A text setting, saved when it loses focus. Emptied, it clears (or, `required`, goes back). */
function TextSetting({
  label,
  value,
  max,
  placeholder,
  multiline,
  required,
  bare,
  className,
  onCommit,
}: {
  label: string
  value: string | null
  max: number
  placeholder?: string
  multiline?: boolean
  required?: boolean
  /** No label shown (the form's name, the editor's heading). */
  bare?: boolean
  className?: string
  onCommit: (v: string | null) => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => setDraft(value ?? ''), [value])
  const commit = () => {
    const v = draft.trim()
    if (!v && required) return setDraft(value ?? '')
    if (v === (value ?? '').trim()) return
    onCommit(v || null)
  }
  const shared = { 'aria-label': label, placeholder, maxLength: max, value: draft, onBlur: commit }
  return (
    <label className="block space-y-1">
      {!bare && <span className="block text-xs text-muted-foreground">{label}</span>}
      {multiline ? (
        <Textarea {...shared} rows={2} className={cn('min-h-0 text-sm', className)} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <Input {...shared} className={cn('h-8', className)} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </label>
  )
}

function AccessChoice({ value, onChange }: { value: FormAccess; onChange: (v: FormAccess) => void }) {
  return (
    <div role="radiogroup" aria-label="Who can fill it in" className="space-y-1">
      {ACCESS_CHOICES.map((a) => (
        <label key={a.value} className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name="form-access" value={a.value} checked={value === a.value} onChange={() => onChange(a.value)} />
          {a.label}
        </label>
      ))}
    </div>
  )
}

function SwitchRow({ label, help, checked, disabled, onChange }: { label: string; help?: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        {help && <span className="block text-xs text-muted-foreground">{help}</span>}
      </span>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

/** A link or snippet with its Copy button. */
function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async () => {
    if (await copyTextToClipboard(value)) setCopied(true)
    else toast.error('Couldn’t copy it. Select the text and copy it yourself.')
  }
  const select = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => e.currentTarget.select()
  return (
    <div className="space-y-1" data-copy-field={label}>
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        {multiline ? (
          // Tall enough for the whole snippet without scrolling: it wraps at any character (one long secret would
          // otherwise push a line out), and grows to fit its text where the browser can size a field to it.
          <textarea
            readOnly
            aria-label={label}
            rows={5}
            className={cn(fieldClass, 'h-auto min-h-0 resize-none break-all py-1.5 font-mono text-xs leading-4 [field-sizing:content]')}
            value={value}
            onFocus={select}
          />
        ) : (
          <input readOnly aria-label={label} className={cn(fieldClass, 'font-mono text-xs')} value={value} onFocus={select} />
        )}
        <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  )
}
