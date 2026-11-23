'use client'

/**
 * A team's GitHub automation, in its settings (docs/plans/github-reviews.md,
 * phase 2; migration 694):
 *
 *   The switch    "Move actions with their pull requests" (team.github_automation,
 *                 on by default). Owners, admins and the team's leads change it,
 *                 as they change the team's other settings (the team's policy).
 *   Repositories  the workspace's list of repositories the automation listens
 *                 to (workspace_github_repo). Owners and admins add and remove
 *                 them; everyone sees them. A repository not on the list moves
 *                 nothing, and one without our webhook sends nothing to move by.
 */
import * as React from 'react'
import { GitBranch, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface RepoRow {
  repo_full_name: string
}

export function GithubAutomationSection({ teamId, enabled, onChanged }: { teamId: string; enabled: boolean; onChanged?: (on: boolean) => void }) {
  const [on, setOn] = React.useState(enabled)
  React.useEffect(() => setOn(enabled), [enabled])
  const [repos, setRepos] = React.useState<RepoRow[] | null>(null)
  const [canManage, setCanManage] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    const res = await fetch('/api/account/github/automation').catch(() => null)
    if (!res?.ok) {
      setRepos([])
      return
    }
    const json = (await res.json()) as { repos?: RepoRow[]; canManage?: boolean }
    setRepos(json.repos ?? [])
    setCanManage(json.canManage === true)
  }, [])
  React.useEffect(() => {
    void load()
  }, [load])

  const flip = async (next: boolean) => {
    setOn(next)
    const res = await fetch(`/api/account/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github_automation: next }),
    }).catch(() => null)
    const json = res ? ((await res.json().catch(() => ({}))) as { team?: { github_automation?: boolean } }) : {}
    if (!res?.ok || json.team?.github_automation !== next) {
      setOn(!next)
      toast.error('Only owners, admins and the team’s leads change this.')
      return
    }
    onChanged?.(next)
  }

  const add = async () => {
    const repo = typed.trim()
    if (!repo) return
    setBusy(true)
    const res = await fetch('/api/account/github/automation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    }).catch(() => null)
    setBusy(false)
    if (!res?.ok) {
      const json = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {}
      toast.error(json.error ?? 'Could not add the repository.')
      return
    }
    setTyped('')
    void load()
  }

  const remove = async (repo: string) => {
    const res = await fetch(`/api/account/github/automation?repo=${encodeURIComponent(repo)}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      toast.error('Could not remove the repository.')
      return
    }
    void load()
  }

  return (
    <div data-github-automation="" className="space-y-4">
      <h2 className="text-sm font-medium">GitHub</h2>
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="flex items-center gap-1.5 text-xs">
            <GitBranch className="h-3 w-3" />
            Move actions with their pull requests
          </Label>
          <p className="text-[11px] text-muted-foreground">
            A branch named for an action starts it, an opened pull request puts it in review, a merge finishes it, and a pull request closed without merging puts it back.
          </p>
        </div>
        <Switch data-github-automation-switch="" checked={on} onCheckedChange={(c) => void flip(c)} />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Repositories (the whole workspace)</p>
        <p className="text-[11px] text-muted-foreground">Only pull requests in these repositories, by members who connected GitHub, move actions.</p>
        {repos === null ? null : repos.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1">
            {repos.map((r) => (
              <li key={r.repo_full_name} data-github-repo={r.repo_full_name} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs">{r.repo_full_name}</span>
                {canManage && (
                  <button type="button" aria-label={`Remove ${r.repo_full_name}`} onClick={() => void remove(r.repo_full_name)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex items-center gap-2">
            <Input
              data-github-repo-input=""
              value={typed}
              placeholder="owner/repo"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
              className="h-8 max-w-xs text-xs"
            />
            <button
              type="button"
              data-github-repo-add=""
              disabled={busy || !typed.trim()}
              onClick={() => void add()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted/60 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
