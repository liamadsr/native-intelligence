'use client'

/**
 * Edit environment (docs/plans/environments.md §6): one dialog for both kinds,
 * opened from the side card's gear, Settings → Environments, the composer's
 * New cloud environment… and the project panel.
 *
 *   A Mac     Name; Folders, the folders shared on that Mac, each with its
 *             mode (the grant's: shown, "change on your Mac"), its base
 *             branch (only once that Mac's app supports one, E3) and its
 *             linked repo (optional, owner/repo); + Add, which opens the
 *             native picker only in the desktop app on THAT Mac and otherwise
 *             says "Add on <Mac name>"; Remove this Mac. No env vars, no
 *             setup script and no worktree choice: a Mac edits on a `dial8/…`
 *             branch, always.
 *   Cloud     Name; Network (restricted for a new one); Environment variables
 *             and Setup script (only to the person who made it and workspace
 *             admins: masked for everyone else, and read-only unless the
 *             server says canEdit); Who can use it (the workspace, or only
 *             me); Archive.
 *
 * Validation mirrors the server's (src/lib/environments/types.ts), and a
 * refusal (ENVIRONMENT_IN_USE, MAC_BUSY) is shown as the server's own sentence.
 * The form mounts with the dialog's content, so each open starts fresh.
 */
import { useMemo, useState, type FormEvent, type ReactNode, type SyntheticEvent } from 'react'
import { AlertCircle, ChevronRight, Folder, GitBranch, Loader2, Plus, User, Users } from 'lucide-react'
import { SiGithub } from '@icons-pack/react-simple-icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  ENVIRONMENT_NAME_MAX,
  ENV_TEXT_MAX_BYTES,
  NEW_CLOUD_NETWORK_ACCESS,
  isBaseBranch,
  isRepoFullName,
  utf8Bytes,
  type CloudEnvironment,
  type NetworkAccess,
} from '@/lib/environments/types'
import {
  addEnvironmentFolder,
  applyEnvironment,
  applyFolderSetting,
  folderParent,
  forgetEnvironment,
  refreshEnvironments,
  useEnvironments,
  useLocalEnvironment,
  type EnvironmentItem,
  type MacEnvironmentItem,
} from '@/lib/local-agent/environment-client'
import {
  archiveEnvironment,
  createCloudEnvironment,
  removeMac,
  saveFolderSetting,
  updateEnvironment,
  type CloudFieldsPatch,
} from './api'
import { EnvironmentKindIcon, MODE_LABEL, NETWORK_LEVELS, NETWORK_NOTE, NETWORK_OPTIONS, OnlineDot } from './environment-meta'

export interface EditEnvironmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The environment to edit; null: a new cloud environment. */
  environment: EnvironmentItem | null
  /** Saved or made: the environment as the server now has it. */
  onSaved?: (environment: EnvironmentItem) => void
  /** Archived (cloud) or removed (a Mac). */
  onGone?: (environmentId: string) => void
}

// ── Validation (the server's rules) ─────────────────────────────────────────

export function nameError(name: string): string | null {
  const t = name.trim()
  if (!t) return 'Name is required'
  if (Array.from(t).length > ENVIRONMENT_NAME_MAX) return `Name must be at most ${ENVIRONMENT_NAME_MAX} characters`
  return null
}

export function baseBranchError(value: string): string | null {
  const t = value.trim()
  return t && !isBaseBranch(t) ? 'The base branch must be a plain local branch name, like main' : null
}

export function repoError(value: string): string | null {
  const t = value.trim()
  return t && !isRepoFullName(t) ? 'The linked repo must look like owner/repo' : null
}

export function textError(value: string, what: 'Env vars' | 'The setup script'): string | null {
  return utf8Bytes(value) > ENV_TEXT_MAX_BYTES ? `${what} can be at most ${ENV_TEXT_MAX_BYTES / 1024} KB` : null
}

/** How many KEY=value lines a .env text holds (comments and blanks aside). */
export function countEnvVars(text: string): number {
  return text.split('\n').filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length
}

// ── The dialog ──────────────────────────────────────────────────────────────

const stop = (e: SyntheticEvent) => e.stopPropagation()

export function EditEnvironmentDialog({ open, onOpenChange, environment, onSaved, onGone }: EditEnvironmentDialogProps) {
  return (
    // The dialog portals out, but its presses and keys still bubble up the
    // React tree to whatever opened it (the composer would take the focus
    // back; the side panel would close on Esc): they stop here.
    <span className="contents" onMouseDown={stop} onClick={stop} onKeyDown={stop} onDragEnter={stop} onDragOver={stop} onDrop={stop}>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-edit-environment={environment?.kind ?? 'new'}
        // Its drops stop at the span above: never the live capture's.
        data-file-drop-zone=""
        // Editing: the dialog itself takes the focus, so no field opens selected; a new one starts in Name.
        onOpenAutoFocus={(e) => {
          if (!environment) return
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
        className="max-h-[min(780px,92vh)] max-w-[520px] gap-5 overflow-y-auto rounded-2xl p-6 focus:outline-none sm:rounded-2xl"
      >
        {environment?.kind === 'mac' ? (
          <MacForm environment={environment} onClose={() => onOpenChange(false)} onSaved={onSaved} onGone={onGone} />
        ) : (
          <CloudForm environment={environment} onClose={() => onOpenChange(false)} onSaved={onSaved} onGone={onGone} />
        )}
      </DialogContent>
    </Dialog>
    </span>
  )
}

interface FormProps<E> {
  environment: E
  onClose: () => void
  onSaved?: (environment: EnvironmentItem) => void
  onGone?: (environmentId: string) => void
}

const SECTION_LABEL = 'text-[13px] font-medium text-foreground'

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" data-environment-error="" className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
        <span className="text-xs text-red-600 dark:text-red-400">{children}</span>
      </div>
    </div>
  )
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-[11px] text-red-600 dark:text-red-400">
      {children}
    </p>
  )
}

/** A short destructive confirm (Remove this Mac, Archive), over the dialog. */
function ConfirmStep({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="rounded-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-environment-confirm=""
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── A Mac ───────────────────────────────────────────────────────────────────

interface FolderRowModel {
  id: string
  label: string
  mode: 'read' | 'edit'
  isGit: boolean
  /** The person's own view of where it is (`~/code/native-intelligence`); empty when the Mac's store hasn't said. */
  parent: string
  baseBranch: string | null
  repoFullName: string | null
}

function MacForm({ environment, onClose, onSaved, onGone }: FormProps<MacEnvironmentItem>) {
  // The list's copy is the live one (a folder just added lands there).
  const environments = useEnvironments({ read: false })
  const mac = (environments.environments.find((e) => e.id === environment.id && e.kind === 'mac') as MacEnvironmentItem | undefined) ?? environment
  const local = useLocalEnvironment()
  const canAdd = local.canEdit && !!local.thisDeviceId && local.thisDeviceId === mac.deviceId
  const online = local.devices.find((d) => d.id === mac.deviceId)?.online ?? mac.online

  const folders = useMemo<FolderRowModel[]>(() => {
    const paths = new Map(local.folders.map((f) => [f.id, f]))
    const rows: FolderRowModel[] = mac.folders.map((f) => ({
      id: f.id,
      label: f.label,
      mode: f.mode,
      isGit: f.isGit,
      parent: folderParent(paths.get(f.id)?.path ?? ''),
      baseBranch: f.baseBranch,
      repoFullName: f.repoFullName,
    }))
    // Shared on the Mac since the list was read: shown now, its settings empty.
    for (const f of local.folders) {
      if (f.deviceId === mac.deviceId && !rows.some((r) => r.id === f.id)) {
        rows.push({ id: f.id, label: f.label, mode: f.mode, isGit: f.isGit, parent: folderParent(f.path), baseBranch: null, repoFullName: null })
      }
    }
    return rows
  }, [mac, local.folders])

  const [name, setName] = useState(mac.name)
  const [drafts, setDrafts] = useState<Record<string, { baseBranch?: string; repoFullName?: string }>>({})
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const valueOf = (f: FolderRowModel, key: 'baseBranch' | 'repoFullName') => drafts[f.id]?.[key] ?? f[key] ?? ''
  // A base branch is where edit jobs branch from: an edit-mode git folder, on a Mac whose app uses it. A linked repo: a git folder.
  const hasBase = (f: FolderRowModel) => mac.supportsBaseBranch && f.mode === 'edit' && f.isGit
  const setDraft = (id: string, key: 'baseBranch' | 'repoFullName', value: string) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }))

  const nameProblem = nameError(name)
  const problems = folders.flatMap((f) => [
    hasBase(f) ? baseBranchError(valueOf(f, 'baseBranch')) : null,
    f.isGit ? repoError(valueOf(f, 'repoFullName')) : null,
  ])
  const invalid = !!nameProblem || problems.some(Boolean)

  async function save(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setError(null)
    if (invalid) return
    setSaving(true)
    try {
      let saved: EnvironmentItem = mac
      if (name.trim() !== mac.name) {
        const res = await updateEnvironment(mac.id, { name: name.trim() })
        if (!res.ok) return setError(res.error)
        saved = res.value
        applyEnvironment(saved)
      }
      for (const f of folders) {
        const patch: { baseBranch?: string; repoFullName?: string } = {}
        const base = valueOf(f, 'baseBranch').trim()
        const repo = valueOf(f, 'repoFullName').trim()
        if (hasBase(f) && base !== (f.baseBranch ?? '')) patch.baseBranch = base
        if (f.isGit && repo !== (f.repoFullName ?? '')) patch.repoFullName = repo
        if (Object.keys(patch).length === 0) continue
        const res = await saveFolderSetting(f.id, patch)
        if (!res.ok) return setError(`${f.label}: ${res.error}`)
        applyFolderSetting(f.id, res.value)
      }
      onSaved?.(saved)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setRemoving(true)
    setError(null)
    try {
      const res = await removeMac(mac.deviceId)
      setConfirmRemove(false)
      // MAC_BUSY says what to do: stop the job first.
      if (!res.ok) return setError(res.error)
      forgetEnvironment(mac.id)
      onGone?.(mac.id)
      onClose()
    } finally {
      setRemoving(false)
    }
  }

  async function add() {
    await addEnvironmentFolder()
    await refreshEnvironments({ force: true })
  }

  return (
    <form onSubmit={save} className="contents">
      <DialogHeader className="space-y-1.5">
        <DialogTitle className="text-base">Edit environment</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5 text-[13px]">
          <EnvironmentKindIcon kind="mac" className="size-3.5" />
          <span className="min-w-0 truncate">{mac.deviceName || mac.name}</span>
          <OnlineDot online={online} className="ml-0.5" />
          <span>{online ? 'Online' : 'Offline'}</span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="environment-name" className={SECTION_LABEL}>
          Name
        </Label>
        <Input
          id="environment-name"
          data-environment-field="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={touched && !!nameProblem}
          className="h-10 rounded-xl"
        />
        {touched && nameProblem && <FieldError id="environment-name-error">{nameProblem}</FieldError>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_LABEL}>Folders</span>
          {canAdd ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-environment-dialog-add=""
              disabled={local.picking}
              onClick={() => void add()}
              className="h-7 gap-1 rounded-lg px-2 text-[13px]"
            >
              {local.picking ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Plus aria-hidden className="size-3.5" />}
              Add
            </Button>
          ) : (
            <span
              data-environment-add-elsewhere=""
              title="Folders are shared from the Native Intelligence desktop app, on the Mac they're on."
              className="text-[12px] text-muted-foreground"
            >
              Add on {mac.name}
            </span>
          )}
        </div>
        {folders.length === 0 ? (
          <p data-environment-no-folders="" className="rounded-xl border border-dashed px-4 py-5 text-center text-[13px] text-muted-foreground">
            No folders shared on this Mac yet.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {folders.map((f) => {
              const showBase = hasBase(f)
              const baseProblem = showBase ? baseBranchError(valueOf(f, 'baseBranch')) : null
              const repoProblem = f.isGit ? repoError(valueOf(f, 'repoFullName')) : null
              return (
                <li key={f.id} data-environment-dialog-folder={f.id} className="space-y-2.5 px-3.5 py-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      <span className="font-medium text-foreground">{f.label}</span>
                      {f.parent && <span className="text-muted-foreground"> · {f.parent}</span>}
                    </span>
                  </div>
                  <p data-environment-mode={f.mode} className="pl-[26px] text-[12px] text-muted-foreground">
                    {MODE_LABEL[f.mode]} <span className="text-muted-foreground/70">· change on your Mac</span>
                  </p>
                  {f.isGit && (
                  <div className={cn('grid gap-2 pl-[26px]', showBase ? 'grid-cols-2' : 'grid-cols-1')}>
                    {showBase && (
                      <label className="min-w-0 space-y-1">
                        <span className="block text-[11px] text-muted-foreground">Base branch</span>
                        <span className="relative block">
                          <GitBranch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            data-environment-field="base-branch"
                            value={valueOf(f, 'baseBranch')}
                            onChange={(e) => setDraft(f.id, 'baseBranch', e.target.value)}
                            placeholder="HEAD"
                            spellCheck={false}
                            autoCapitalize="off"
                            aria-invalid={!!baseProblem}
                            className="h-8 rounded-lg pl-7 font-mono text-xs"
                          />
                        </span>
                      </label>
                    )}
                    <label className="min-w-0 space-y-1">
                      <span className="block text-[11px] text-muted-foreground">Linked repo (optional)</span>
                      <span className="relative block">
                        <SiGithub aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          data-environment-field="repo"
                          value={valueOf(f, 'repoFullName')}
                          onChange={(e) => setDraft(f.id, 'repoFullName', e.target.value)}
                          placeholder="owner/repo"
                          spellCheck={false}
                          autoCapitalize="off"
                          aria-invalid={!!repoProblem}
                          className="h-8 rounded-lg pl-7 font-mono text-xs"
                        />
                      </span>
                    </label>
                  </div>
                  )}
                  {(baseProblem || repoProblem) && (
                    <div className="pl-[26px]">
                      {baseProblem && <FieldError id={`${f.id}-base-error`}>{baseProblem}</FieldError>}
                      {repoProblem && <FieldError id={`${f.id}-repo-error`}>{repoProblem}</FieldError>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Native Intelligence edits on a <span className="font-mono">dial8/…</span> branch in its own worktree, so your checkout is never touched.
          {mac.supportsBaseBranch ? ' A base branch is where those branches start.' : ''} A linked repo lets a job move to the cloud
          while this Mac is offline, once you say so.
        </p>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      <DialogFooter className="items-center gap-2 sm:justify-between sm:space-x-0">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-environment-remove-mac=""
          onClick={() => setConfirmRemove(true)}
          className="h-8 rounded-lg px-2.5 text-[13px] text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Remove this Mac
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving} className="h-9 rounded-xl">
            Cancel
          </Button>
          <Button type="submit" data-environment-save="" disabled={saving} className="h-9 rounded-xl px-4">
            {saving && <Loader2 aria-hidden className="mr-1.5 size-3 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogFooter>

      <ConfirmStep
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove this Mac?"
        description={`${mac.name} leaves Native Intelligence: its folders stop being shared, and chats that used it move to your next default. Its jobs, branches and pull requests stay. Share a folder on that Mac to bring it back.`}
        confirmLabel="Remove"
        busyLabel="Removing…"
        busy={removing}
        onConfirm={() => void remove()}
      />
    </form>
  )
}

// ── Cloud ───────────────────────────────────────────────────────────────────

function OptionRows<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  field,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; title: string; helper: string; icon: ReactNode }>
  onChange: (value: T) => void
  disabled?: boolean
  field: string
}) {
  return (
    <div role="radiogroup" aria-label={label} data-environment-field={field} className="divide-y overflow-hidden rounded-xl border">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-environment-option={o.value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default motion-reduce:transition-none',
              on ? 'bg-muted/60' : 'hover:bg-muted/30 disabled:hover:bg-transparent',
            )}
          >
            <span className="mt-0.5 text-muted-foreground">{o.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-foreground">{o.title}</span>
              <span className="block text-[12px] leading-snug text-muted-foreground">{o.helper}</span>
            </span>
            <span
              aria-hidden
              className={cn(
                'mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border',
                on ? 'border-foreground bg-foreground' : 'border-muted-foreground/40',
              )}
            >
              {on && <span className="size-1.5 rounded-full bg-background" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A row that opens a text field under it (Environment variables, Setup script); a viewer who can't see it gets the row only. */
function DisclosureRow({
  field,
  title,
  summary,
  open,
  onToggle,
  locked,
  children,
}: {
  field: string
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  locked: boolean
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border" data-environment-disclosure={field}>
      <button
        type="button"
        aria-expanded={locked ? undefined : open}
        disabled={locked}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none"
      >
        <span className="min-w-0 flex-1 text-[13px] font-medium text-foreground">{title}</span>
        <span data-environment-summary={field} className="truncate text-[13px] text-muted-foreground">
          {summary}
        </span>
        {!locked && (
          <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        )}
      </button>
      {open && !locked && <div className="space-y-2 border-t px-3.5 pb-3.5 pt-3">{children}</div>}
    </div>
  )
}

const SETUP_PLACEHOLDER = '#!/bin/bash\nnpm install'

function CloudForm({ environment, onClose, onSaved, onGone }: FormProps<CloudEnvironment | null>) {
  const isNew = environment === null
  const editable = isNew || environment.canEdit
  const [name, setName] = useState(environment?.name ?? '')
  const [network, setNetwork] = useState<NetworkAccess>(environment?.networkAccess ?? NEW_CLOUD_NETWORK_ACCESS)
  const [envVars, setEnvVars] = useState(environment?.envVars ?? '')
  const [setupScript, setSetupScript] = useState(environment?.setupScript ?? '')
  const [shared, setShared] = useState(environment?.shared ?? true)
  const [envOpen, setEnvOpen] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const nameProblem = nameError(name)
  const envProblem = textError(envVars, 'Env vars')
  const scriptProblem = textError(setupScript, 'The setup script')
  const invalid = !!nameProblem || !!envProblem || !!scriptProblem

  const varCount = countEnvVars(envVars)
  const envSummary = !editable
    ? environment?.hasEnvVars
      ? 'Set · hidden'
      : 'None for this environment'
    : varCount > 0
      ? `${varCount} ${varCount === 1 ? 'variable' : 'variables'}`
      : 'None for this environment'
  const scriptSummary = !editable
    ? environment?.hasSetupScript
      ? 'Set · hidden'
      : 'None'
    : setupScript.trim()
      ? `${setupScript.trim().split('\n').length} ${setupScript.trim().split('\n').length === 1 ? 'line' : 'lines'}`
      : 'None'

  async function save(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setError(null)
    if (!editable || invalid) return
    // A new one sends everything; an edit only what changed (an unchanged `shared` never trips ENVIRONMENT_IN_USE).
    const patch: CloudFieldsPatch = {}
    if (isNew || name.trim() !== environment.name) patch.name = name.trim()
    if (isNew || network !== environment.networkAccess) patch.networkAccess = network
    if (isNew ? envVars !== '' : envVars !== (environment.envVars ?? '')) patch.envVars = envVars
    if (isNew ? setupScript !== '' : setupScript !== (environment.setupScript ?? '')) patch.setupScript = setupScript
    if (isNew || shared !== environment.shared) patch.shared = shared
    if (!isNew && Object.keys(patch).length === 0) return onClose()
    setSaving(true)
    try {
      const res = isNew ? await createCloudEnvironment(patch) : await updateEnvironment(environment.id, patch)
      // ENVIRONMENT_IN_USE (made "only me" while a project uses it) says what to do.
      if (!res.ok) return setError(res.error)
      applyEnvironment(res.value)
      onSaved?.(res.value)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function archive() {
    if (!environment) return
    setArchiving(true)
    setError(null)
    try {
      const res = await archiveEnvironment(environment.id)
      setConfirmArchive(false)
      if (!res.ok) return setError(res.error)
      forgetEnvironment(environment.id)
      onGone?.(environment.id)
      onClose()
    } finally {
      setArchiving(false)
    }
  }

  return (
    <form onSubmit={save} className="contents">
      <DialogHeader className="space-y-1.5">
        <DialogTitle className="text-base">{isNew ? 'New cloud environment' : 'Edit environment'}</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5 text-[13px]">
          <EnvironmentKindIcon kind="cloud" className="size-3.5" />
          <span>A fresh cloud sandbox for each run. The repo comes from the work.</span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="environment-name" className={SECTION_LABEL}>
          Name
        </Label>
        <Input
          id="environment-name"
          data-environment-field="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Frontend, CI"
          disabled={!editable}
          autoFocus={isNew}
          aria-invalid={touched && !!nameProblem}
          className="h-10 rounded-xl"
        />
        {touched && nameProblem && <FieldError id="environment-name-error">{nameProblem}</FieldError>}
      </div>

      <div className="space-y-2">
        <span className={SECTION_LABEL}>Network</span>
        <OptionRows
          label="Network"
          field="network"
          value={network}
          onChange={setNetwork}
          disabled={!editable}
          options={NETWORK_LEVELS.map((level) => {
            const opt = NETWORK_OPTIONS[level]
            const Icon = opt.icon
            return { value: level, title: opt.label, helper: opt.helper, icon: <Icon className="size-4" /> }
          })}
        />
        <p className="text-[12px] text-muted-foreground">{NETWORK_NOTE}</p>
      </div>

      <div className="space-y-2">
        <DisclosureRow
          field="env-vars"
          title="Environment variables"
          summary={envSummary}
          open={envOpen}
          onToggle={() => setEnvOpen((o) => !o)}
          locked={!editable}
        >
          <Textarea
            data-environment-field="env-vars"
            aria-label="Environment variables"
            className="min-h-[110px] resize-y rounded-lg font-mono text-xs"
            placeholder={'KEY=value\nANOTHER_KEY=value'}
            value={envVars}
            onChange={(e) => setEnvVars(e.target.value)}
            spellCheck={false}
          />
          {envProblem && <FieldError id="environment-env-error">{envProblem}</FieldError>}
          <p className="text-[11px] leading-snug text-muted-foreground">
            Stored in plain text. Only the person who made this environment and workspace admins can see them; a run can print
            them. Don’t add real secrets yet.
          </p>
        </DisclosureRow>
        <DisclosureRow
          field="setup-script"
          title="Setup script"
          summary={scriptSummary}
          open={scriptOpen}
          onToggle={() => setScriptOpen((o) => !o)}
          locked={!editable}
        >
          <Textarea
            data-environment-field="setup-script"
            aria-label="Setup script"
            className="min-h-[100px] resize-y rounded-lg font-mono text-xs"
            placeholder={SETUP_PLACEHOLDER}
            value={setupScript}
            onChange={(e) => setSetupScript(e.target.value)}
            spellCheck={false}
          />
          {scriptProblem && <FieldError id="environment-script-error">{scriptProblem}</FieldError>}
          <p className="text-[11px] text-muted-foreground">Bash run after the repo is cloned, before the agent starts.</p>
        </DisclosureRow>
      </div>

      <div className="space-y-2">
        <span className={SECTION_LABEL}>Who can use it</span>
        <OptionRows
          label="Who can use it"
          field="shared"
          value={shared ? 'workspace' : 'me'}
          onChange={(v) => setShared(v === 'workspace')}
          disabled={!editable}
          options={[
            { value: 'workspace', title: 'The workspace', helper: 'Everyone in this workspace, and its projects.', icon: <Users className="size-4" /> },
            { value: 'me', title: 'Only me', helper: 'Only you. A project can’t use it.', icon: <User className="size-4" /> },
          ]}
        />
      </div>

      {!editable && (
        <p data-environment-readonly="" className="text-[12px] text-muted-foreground">
          Only the person who made it or a workspace admin can change it.
        </p>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}

      <DialogFooter className="items-center gap-2 sm:justify-between sm:space-x-0">
        {!isNew && environment.canEdit ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-environment-archive=""
            onClick={() => setConfirmArchive(true)}
            className="h-8 rounded-lg px-2.5 text-[13px] text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Archive
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {editable ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose} disabled={saving} className="h-9 rounded-xl">
                Cancel
              </Button>
              <Button type="submit" data-environment-save="" disabled={saving} className="h-9 rounded-xl px-4">
                {saving && <Loader2 aria-hidden className="mr-1.5 size-3 animate-spin" />}
                {isNew ? 'Create' : 'Save'}
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose} className="h-9 rounded-xl">
              Close
            </Button>
          )}
        </div>
      </DialogFooter>

      {environment && (
        <ConfirmStep
          open={confirmArchive}
          onOpenChange={setConfirmArchive}
          title="Archive this environment?"
          description={`${environment.name} leaves every list. Chats that used it move to the next default; runs that used it keep their record of it.`}
          confirmLabel="Archive"
          busyLabel="Archiving…"
          busy={archiving}
          onConfirm={() => void archive()}
        />
      )}
    </form>
  )
}
