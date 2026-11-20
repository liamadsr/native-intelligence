'use client'

/**
 * "Which folder on <Mac> holds <repo>?" at an action's Start, when no folder
 * on the picked Mac is linked to the project's repo (the owner's ask, 11-20:
 * offer the Mac's folders and link the one picked, instead of refusing).
 *
 * Only the Mac's git folders are offered. The one whose name matches the
 * repo's (`native-intelligence` for `liamadsr/native-intelligence`) is
 * preselected when it can be used, never picked silently: the person presses
 * the button. A read-only folder shows, with the sentence the Start would
 * refuse it with, and can't be picked; one linked to another repo shows that
 * repo and is never preselected. A Mac with no git folder says to add the
 * folder in the desktop app.
 *
 * `mode`: 'start' (from the Start: the panel links it with the Start itself,
 * POST …/start-agent `folderId`) or 'link' (from "Run on", before the press:
 * linked here, the same write Edit environment makes). Either way it stays
 * linked, so the question doesn't come back.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, FolderGit2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

export { PopoverAnchor as StartFolderAnchor }
import { cn } from '@/lib/utils'
import { editsNotAllowedReason } from '@/lib/environments/types'
import { applyFolderSetting, type MacEnvironmentItem } from '@/lib/local-agent/environment-client'
import { saveFolderSetting } from './api'

export interface FolderChoiceRow {
  id: string
  label: string
  /** Why it can't be picked (read-only), else null. */
  blocked: string | null
  /** The other repo it is linked to, if any (pickable, never preselected). */
  otherRepo: string | null
}

/**
 * The folders to offer for `repo` on this Mac (git folders only), and the
 * one to preselect: the usable, unlinked folder whose name is the repo's
 * name. Null when the Mac has no git folder. Pure.
 */
export function folderChoices(mac: Pick<MacEnvironmentItem, 'name' | 'folders'>, repo: string): { rows: FolderChoiceRow[]; preselect: string | null } | null {
  const git = mac.folders.filter((f) => f.isGit)
  if (git.length === 0) return null
  const name = (repo.split('/').pop() ?? '').toLowerCase()
  const rows = git.map((f) => ({
    id: f.id,
    label: f.label,
    blocked: f.mode === 'edit' ? null : editsNotAllowedReason(f, mac.name || 'your Mac'),
    otherRepo: f.repoFullName && f.repoFullName.toLowerCase() !== repo.toLowerCase() ? f.repoFullName : null,
  }))
  const match = rows.find((r) => !r.blocked && !r.otherRepo && r.label.toLowerCase() === name)
  return { rows, preselect: match?.id ?? null }
}

export interface StartFolderChoiceProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mac: MacEnvironmentItem | null
  repo: string | null
  mode: 'start' | 'link'
  /** 'start': link this folder with the Start, and start. */
  onStart?: (folderId: string) => void
  /** The rest of the control, with a PopoverAnchor (re-exported here) around what the popover points at. */
  children: ReactNode
}

export function StartFolderChoice({ open, onOpenChange, mac, repo, mode, onStart, children }: StartFolderChoiceProps) {
  const choice = mac && repo ? folderChoices(mac, repo) : null
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const preselect = choice?.preselect ?? null
  // Each opening starts from the match (or nothing), never a leftover pick.
  useEffect(() => {
    if (open) setPicked(preselect)
  }, [open, preselect])
  const macName = mac?.name || 'your Mac'

  async function confirm() {
    if (!picked || !repo) return
    if (mode === 'start') {
      onOpenChange(false)
      onStart?.(picked)
      return
    }
    setSaving(true)
    const res = await saveFolderSetting(picked, { repoFullName: repo })
    setSaving(false)
    if (!res.ok) {
      toast.error('Couldn’t link the folder', { description: res.error })
      return
    }
    applyFolderSetting(picked, res.value)
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
      <PopoverContent align="end" side="bottom" className="w-72 p-0" data-start-folder-choice="">
        <div className="px-3 pb-2 pt-3">
          <p className="text-sm font-medium">Which folder on {macName} holds {repo}?</p>
          {choice && <p className="mt-0.5 text-xs text-muted-foreground">It stays linked, so you only choose once.</p>}
        </div>
        {!choice ? (
          <p data-start-folder-choice-none="" className="px-3 pb-3 text-xs text-muted-foreground">
            No git folder on {macName} is shared with Native Intelligence. Add the folder in the Native Intelligence app on your Mac, then press Start again.
          </p>
        ) : (
          <>
            <div role="radiogroup" aria-label={`Folders on ${macName}`} className="max-h-60 overflow-y-auto px-1">
              {choice.rows.map((r) => {
                const on = picked === r.id
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!!r.blocked}
                    data-start-folder-option={r.id}
                    {...(r.blocked ? { 'data-start-folder-blocked': '' } : {})}
                    onClick={() => setPicked(r.id)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-2xl px-2 py-2 text-left text-sm transition-colors',
                      r.blocked ? 'cursor-default text-muted-foreground' : 'hover:bg-muted/60',
                      on && 'bg-muted',
                    )}
                  >
                    <FolderGit2 aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{r.label}</span>
                      {r.blocked && <span className="block text-xs">{r.blocked}</span>}
                      {!r.blocked && r.otherRepo && <span className="block text-xs text-muted-foreground">Linked to {r.otherRepo} now</span>}
                    </span>
                    <Check aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', on ? 'text-foreground' : 'invisible')} />
                  </button>
                )
              })}
            </div>
            <div className="flex justify-end gap-2 border-t px-3 py-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" data-start-folder-confirm="" disabled={!picked || saving} onClick={() => void confirm()}>
                {saving && <Loader2 aria-hidden className="mr-1 size-3.5 animate-spin" />}
                {mode === 'start' ? 'Link and start' : 'Link folder'}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
