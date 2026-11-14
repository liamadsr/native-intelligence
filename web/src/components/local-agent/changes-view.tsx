'use client'

/**
 * "Changes": what an edit job changed on its branch, read from the Mac it
 * ran on (tauri-bridge.ts `local_agent_diff`) when the view opens. The
 * person's code never goes to the server for it: the view is there only in
 * the desktop app on that Mac; anywhere else it says where to read it, and
 * links the pull request when there is one.
 *
 *   summary   files changed, lines added and removed, the branch and base,
 *             and plainly when the Mac cut the diff (its limits)
 *   files     each with how it changed and its counts; its unified diff
 *             drawn as the document history draws one (diff-line-row.tsx),
 *             with line numbers. A long one opens collapsed; one listed
 *             without a patch (binary, a secret-looking name, cut) says so
 *   notes     select a line, or a whole file, and add a note; the notes
 *             collect at the bottom and "Send to agent" posts them to the
 *             job as ONE follow-up message, each with its file and line.
 *             Nothing is kept beyond that message.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest, Laptop, Loader2, MessageSquarePlus, RefreshCw, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { DiffLineRow } from '@/components/documents/diff-line-row'
import { cn } from '@/lib/utils'
import { isDesktopApp } from '@/lib/platform'
import { tauriBridge, type LocalAgentDiff, type LocalAgentDiffFile } from '@/lib/tauri-bridge'
import { isGithubPullRequestUrl } from '@/lib/local-agent/pull-request'
import {
  NOTE_MAX,
  NOTES_MAX,
  noteWhere,
  notesFit,
  stripControl,
  parseUnifiedPatch,
  reviewNotesMessage,
  startsCollapsed,
  type ReviewNote,
} from '@/lib/local-agent/changes'

/** Where the diff can be read: here (the app on the job's Mac), or not. */
export type ChangesPlace = 'checking' | 'here' | 'elsewhere'

/** The view's read of the Mac. */
export type ChangesState =
  | { kind: 'loading' }
  | { kind: 'ready'; diff: LocalAgentDiff }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export interface ChangesViewProps {
  sessionId: string
  /** The Mac the job ran on (the session's device). */
  deviceId: string
  deviceName: string
  branch: string | null
  prUrl?: string | null
  /** The job can take a message now: "Send to agent" posts the notes. */
  canMessage: boolean
  /** The job's existing message path (the panel's `send`): the notes go as one follow-up. */
  onSendNotes: (text: string) => Promise<{ ok: true } | { ok: false; message: string }>
  className?: string
}

const STATUS_WORD: Record<LocalAgentDiffFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
}

const STATUS_TONE: Record<LocalAgentDiffFile['status'], string> = {
  added: 'text-emerald-700 dark:text-emerald-400',
  modified: 'text-sky-700 dark:text-sky-400',
  deleted: 'text-rose-700 dark:text-rose-400',
  renamed: 'text-amber-700 dark:text-amber-400',
}

/** Whether this window is the desktop app on the job's own Mac. */
export function useChangesPlace(deviceId: string): ChangesPlace {
  const [place, setPlace] = useState<ChangesPlace>(() => (isDesktopApp() ? 'checking' : 'elsewhere'))
  useEffect(() => {
    if (!isDesktopApp()) return
    let cancelled = false
    void tauriBridge.localAgent.device().then((res) => {
      if (!cancelled) setPlace(res.ok && res.value.deviceId === deviceId ? 'here' : 'elsewhere')
    })
    return () => {
      cancelled = true
    }
  }, [deviceId])
  return place
}

function newNoteId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export function ChangesView({ sessionId, deviceId, deviceName, branch, prUrl, canMessage, onSendNotes, className }: ChangesViewProps) {
  const place = useChangesPlace(deviceId)
  const [state, setState] = useState<ChangesState>({ kind: 'loading' })
  const [notes, setNotes] = useState<ReviewNote[]>([])
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setState({ kind: 'loading' })
    const res = await tauriBridge.localAgent.diff(sessionId)
    if (mine !== seq.current) return
    if (res.ok) setState({ kind: 'ready', diff: res.value })
    else if (res.unavailable) setState({ kind: 'unsupported' })
    else setState({ kind: 'error', message: res.error })
  }, [sessionId])

  useEffect(() => {
    if (place === 'here') void load()
  }, [place, load])

  const addNote = useCallback((note: Omit<ReviewNote, 'id'>) => {
    setSent(null)
    setSendError(null)
    setNotes((all) => (all.length >= NOTES_MAX ? all : [...all, { ...note, id: newNoteId() }]))
  }, [])
  const removeNote = useCallback((id: string) => setNotes((all) => all.filter((n) => n.id !== id)), [])

  const message = useMemo(() => reviewNotesMessage(notes), [notes])
  const fits = message ? notesFit(message) : true

  const send = async () => {
    if (!message || !fits || !canMessage) return
    setSending(true)
    setSendError(null)
    const res = await onSendNotes(message)
    setSending(false)
    if (res.ok) {
      setSent(`${notes.length === 1 ? 'Your note went' : `Your ${notes.length} notes went`} to the agent as one message.`)
      setNotes([])
    } else {
      setSendError(res.message)
    }
  }

  const pr = isGithubPullRequestUrl(prUrl) ? prUrl : null

  if (place !== 'here') {
    return (
      <div data-local-agent-changes="" data-changes-place={place} className={cn('flex flex-col gap-2 py-2 text-sm', className)}>
        {place === 'checking' ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <p data-changes-elsewhere="" className="flex items-start gap-2 text-muted-foreground">
            <Laptop aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>The changes can be read in the Native Intelligence app on {deviceName || 'the Mac that made them'}.</span>
          </p>
        )}
        {place === 'elsewhere' && pr && <PullRequestLink url={pr} />}
      </div>
    )
  }

  return (
    <div data-local-agent-changes="" data-changes-place="here" className={cn('flex min-h-0 flex-col gap-3', className)}>
      {state.kind === 'loading' && (
        <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          Reading the changes on this Mac…
        </p>
      )}
      {state.kind === 'unsupported' && (
        <p data-changes-unsupported="" className="py-2 text-sm text-muted-foreground">
          This version of the app can’t show the changes yet. Update Native Intelligence on this Mac to read them here.
        </p>
      )}
      {state.kind === 'error' && (
        <div data-changes-error="" className="flex items-start justify-between gap-2 py-2 text-sm">
          <p className="text-destructive">The changes couldn’t be read: {state.message}</p>
          <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={() => void load()}>
            <RefreshCw className="h-3 w-3" />
            Try again
          </Button>
        </div>
      )}
      {state.kind === 'ready' && <DiffBody diff={state.diff} branch={branch} onAddNote={addNote} onReload={() => void load()} />}

      {(notes.length > 0 || sent) && (
        <div data-changes-notes={notes.length} className="shrink-0 rounded-xl border border-border/60 bg-card/50 px-3 py-2.5 text-xs">
          {notes.length > 0 && (
            <>
              <p className="mb-1.5 font-medium text-foreground">
                {notes.length === 1 ? '1 note' : `${notes.length} notes`} for the agent
              </p>
              <ul className="space-y-1">
                {notes.map((n) => (
                  <li key={n.id} data-changes-note={noteWhere(n)} className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 break-words">
                      <span className="font-mono text-[11px] text-muted-foreground">{noteWhere(n)}</span>
                      <span className="text-foreground/90">: {n.text}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove the note on ${noteWhere(n)}`}
                      onClick={() => removeNote(n.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center justify-end gap-2">
                {!canMessage && <span className="mr-auto text-muted-foreground">This job can’t take a message now.</span>}
                {canMessage && !fits && <span className="mr-auto text-destructive">Too long for one message: send fewer notes at a time.</span>}
                {sendError && <span className="mr-auto text-destructive">{sendError}</span>}
                <Button size="sm" className="h-7 gap-1.5 text-xs" data-changes-send="" disabled={!canMessage || !fits || sending} onClick={() => void send()}>
                  {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Send to agent
                </Button>
              </div>
            </>
          )}
          {notes.length === 0 && sent && (
            <p data-changes-sent="" className="text-muted-foreground">
              {sent}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PullRequestLink({ url }: { url: string }) {
  const number = /\/pull\/(\d+)$/.exec(url)?.[1]
  return (
    <a
      data-changes-pr={url}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-xs text-foreground/80 underline-offset-2 hover:underline"
    >
      <GitPullRequest aria-hidden className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="truncate">{number ? `Read them in pull request #${number}` : 'Read them in the pull request'}</span>
      <ExternalLink aria-hidden className="h-2.5 w-2.5 shrink-0" />
    </a>
  )
}

function DiffBody({
  diff,
  branch,
  onAddNote,
  onReload,
}: {
  diff: LocalAgentDiff
  branch: string | null
  onAddNote: (n: Omit<ReviewNote, 'id'>) => void
  onReload: () => void
}) {
  const added = diff.files.reduce((n, f) => n + f.additions, 0)
  const removed = diff.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p data-changes-summary="" className="min-w-0 text-xs text-muted-foreground">
          {diff.files.length === 1 ? '1 file changed' : `${diff.files.length} files changed`}
          {' · '}
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{' '}
          <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
          {(diff.head || branch) && (
            <>
              {' · '}
              <span className="font-mono">{branch || diff.head.slice(0, 7)}</span>
              {diff.base ? <> against <span className="font-mono">{diff.base}</span></> : null}
            </>
          )}
        </p>
        <button
          type="button"
          onClick={onReload}
          aria-label="Read the changes again"
          title="Read the changes again"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      {diff.truncated && (
        <p data-changes-truncated="" className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          Not every change is shown: the app shows at most 300 files, 200 KB of one file and 2 MB in all. The rest is on the branch.
        </p>
      )}
      {diff.files.length === 0 ? (
        <p data-changes-empty="" className="py-2 text-sm text-muted-foreground">
          No changes on this branch yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {diff.files.map((f) => (
            <li key={`${f.oldPath ?? ''}>${f.path}`} className="min-w-0">
              <FileDiff file={f} onAddNote={onAddNote} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What a file listed without a patch says instead. */
export function noPreviewText(file: Pick<LocalAgentDiffFile, 'binary' | 'patch' | 'status'>): string | null {
  if (file.binary) return 'Binary file: no preview.'
  if (file.patch) return null
  if (file.status === 'renamed') return 'Renamed without changes.'
  return 'No preview: the app lists this file without its contents (a name that looks like it holds secrets, or past its size limit).'
}

/** A path as its folders and its file name ("src/lib/" and "a.ts"): the name is what stays whole. Pure. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

/** A file's +/− counts say something: not for a binary file, nor a rename that changed nothing (their status word says it). Pure. */
export function showsCounts(file: Pick<LocalAgentDiffFile, 'binary' | 'status' | 'additions' | 'deletions'>): boolean {
  if (file.binary) return false
  return !(file.status === 'renamed' && file.additions === 0 && file.deletions === 0)
}

/** A path on one line: the folders are cut (with an ellipsis) before the file name is. */
function PathLabel({ path, className }: { path: string; className?: string }) {
  const { dir, name } = splitPath(stripControl(path))
  return (
    <span className={cn('flex min-w-0 font-mono text-[12px]', className)}>
      {dir && <span className="min-w-0 shrink-[999] truncate text-muted-foreground">{dir}</span>}
      <span className="min-w-0 shrink truncate text-foreground">{name}</span>
    </span>
  )
}

type Selected = { line: number | null; side?: 'new' | 'old'; excerpt?: string } | null

const FileDiff = memo(function FileDiff({ file, onAddNote }: { file: LocalAgentDiffFile; onAddNote: (n: Omit<ReviewNote, 'id'>) => void }) {
  const [open, setOpen] = useState(() => !startsCollapsed(file))
  const [selected, setSelected] = useState<Selected>(null)
  const [draft, setDraft] = useState('')
  const rows = useMemo(() => (open && file.patch ? parseUnifiedPatch(file.patch) : []), [open, file.patch])
  const noPreview = noPreviewText(file)

  const pick = (s: Selected) => {
    setSelected(s)
    setDraft('')
    if (s && !open) setOpen(true)
  }
  const toggle = (line: number | null, side: 'new' | 'old', excerpt: string, isSelected: boolean) => {
    if (line !== null) pick(isSelected ? null : { line, side, excerpt })
  }
  const save = () => {
    const text = draft.trim()
    if (!text || !selected) return
    onAddNote({
      path: file.path,
      line: selected.line,
      ...(selected.side ? { side: selected.side } : {}),
      ...(selected.excerpt !== undefined ? { excerpt: selected.excerpt } : {}),
      text: text.slice(0, NOTE_MAX),
    })
    setSelected(null)
    setDraft('')
  }

  const editor = (
    <div data-changes-note-editor="" className="border-y border-border/60 bg-background px-3 py-2 font-sans">
      <Textarea
        autoFocus
        value={draft}
        maxLength={NOTE_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          if (e.key === 'Escape') setSelected(null)
        }}
        placeholder={selected?.line === null ? `A note on ${stripControl(file.path)}` : 'A note on this line'}
        aria-label={selected ? `Note on ${noteWhere({ path: file.path, line: selected.line, side: selected.side })}` : 'Note'}
        className="min-h-[56px] text-xs"
      />
      <div className="mt-1.5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(null)}>
          Cancel
        </Button>
        <Button size="sm" className="h-7 text-xs" data-changes-add-note="" disabled={!draft.trim()} onClick={save}>
          Add note
        </Button>
      </div>
    </div>
  )

  return (
    <div data-changes-file={file.path} data-changes-file-status={file.status} className="overflow-hidden rounded-md border border-border">
      <div className="flex min-w-0 items-center gap-2 bg-muted/30 px-2 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
          data-changes-toggle=""
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          <span className={cn('shrink-0 text-[11px] font-medium', STATUS_TONE[file.status])}>{STATUS_WORD[file.status]}</span>
          <span data-changes-path="" className="flex min-w-0 items-center gap-1" title={stripControl(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)}>
            {file.oldPath ? (
              <>
                {/* A rename: both names as far as the width allows; the old one gives first. */}
                <PathLabel path={file.oldPath} className="shrink-[999]" />
                <span aria-hidden className="shrink-0 text-muted-foreground">→</span>
                <PathLabel path={file.path} className="shrink" />
              </>
            ) : (
              <PathLabel path={file.path} />
            )}
          </span>
        </button>
        {showsCounts(file) && (
          <span data-changes-counts="" className="shrink-0 tabular-nums text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
            <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span>
          </span>
        )}
        <button
          type="button"
          data-changes-file-note=""
          onClick={() => pick({ line: null })}
          aria-label={`Add a note on ${file.path}`}
          title="Add a note on this file"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
      </div>
      {selected?.line === null && editor}
      {open &&
        (noPreview ? (
          <p data-changes-no-preview="" className="px-3 py-2 text-xs text-muted-foreground">
            {noPreview}
          </p>
        ) : (
          <div className="font-mono text-xs leading-5">
            {rows.map((row, i) => {
              if (row.kind === 'hunk') {
                return (
                  <div key={i} data-changes-hunk="" title={row.header} className="truncate bg-muted/40 px-3 py-0.5 text-[11px] text-muted-foreground">
                    {row.header}
                  </div>
                )
              }
              const side: 'new' | 'old' = row.kind === 'removed' ? 'old' : 'new'
              const line = (side === 'old' ? row.oldLine : row.newLine) ?? null
              const isSelected = selected !== null && selected.line === line && (selected.side ?? 'new') === side && line !== null
              return (
                <div key={i}>
                  {/* A line is selectable (a div with the button role: the row is a block, which a button can't hold). */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    data-changes-line={`${side}:${line}`}
                    onClick={() => toggle(line, side, row.text, isSelected)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggle(line, side, row.text, isSelected)
                      }
                    }}
                    aria-label={line === null ? undefined : `Add a note on ${noteWhere({ path: file.path, line, side })}`}
                    className={cn('cursor-pointer hover:brightness-95 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring', isSelected && 'ring-1 ring-inset ring-ring')}
                  >
                    <DiffLineRow variant="code" kind={row.kind} text={row.text} oldLine={row.oldLine} newLine={row.newLine} />
                  </div>
                  {isSelected && editor}
                </div>
              )
            })}
          </div>
        ))}
    </div>
  )
})
