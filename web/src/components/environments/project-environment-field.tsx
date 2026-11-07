'use client'

/**
 * The project panel's Environment rows (docs/plans/environments.md §6, §7 Q7):
 *
 *   Environment     the project's own: one of the workspace's SHARED cloud
 *                   environments (never a Mac, never an "only me" one; the
 *                   server refuses either). Linked, its name and network
 *                   level with × to unlink; unlinked, Link environment, a
 *                   picker read when it opens, with New environment… (Edit
 *                   environment, then linked).
 *   Run my work     your own switch, "Run my work here on <your Mac>": actions
 *   here on…        YOU start in this project run on your Mac (as unattended
 *                   work); a teammate's still run in the project's cloud
 *                   environment. Only when you have a Mac. On, with no folder
 *                   on that Mac linked to the project's repo, a line says so
 *                   and opens that Mac's Edit environment to link one.
 *
 * The list is the shared environments store (read on mount, unless fresh).
 * Your switch is read once per project, only when you have a Mac (GET
 * …/environments/default?workspaceId&projectId), and set with PUT
 * …/environments/default; a read that fails shows no switch rather than a
 * wrong one.
 */
import { useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import type { NetworkAccess } from '@/lib/environments/types'
import {
  refreshEnvironments,
  useEnvironments,
  type EnvironmentItem,
  type MacEnvironmentItem,
} from '@/lib/local-agent/environment-client'
import { readProjectMacDefault, setProjectMacDefault } from './api'
import { EditEnvironmentDialog } from './edit-environment-dialog'
import { EnvironmentKindIcon, NETWORK_OPTIONS } from './environment-meta'

export interface ProjectEnvironmentLink {
  id: string
  name: string
  networkAccess: NetworkAccess
}

export interface ProjectEnvironmentFieldProps {
  projectId: string
  workspaceId?: string | null
  /** The project's repo (owner/repo), for "is a folder on my Mac linked to it?". */
  githubRepo: string | null
  environmentId: string | null
  environmentName: string | null
  environmentNetworkAccess: NetworkAccess | null
  /** Link the project to a shared cloud environment, or unlink it (null). */
  onLink: (environment: ProjectEnvironmentLink | null) => void
}

/** Your switch for this project: loading, off/on (the Mac environment it names), or unknown (the read failed). */
type MacDefault = { state: 'loading' } | { state: 'ready'; environmentId: string | null } | { state: 'unknown' }

/** Does a folder on this Mac name the project's repo (GitHub names ignore case)? */
export function macLinksRepo(mac: Pick<MacEnvironmentItem, 'folders'>, repo: string | null): boolean {
  if (!repo) return true
  const want = repo.toLowerCase()
  return mac.folders.some((f) => f.repoFullName?.toLowerCase() === want)
}

export function ProjectEnvironmentField({
  projectId,
  workspaceId,
  githubRepo,
  environmentId,
  environmentName,
  environmentNetworkAccess,
  onLink,
}: ProjectEnvironmentFieldProps) {
  const list = useEnvironments()
  const macs = list.environments.filter((e): e is MacEnvironmentItem => e.kind === 'mac')
  const shared = list.environments.filter((e) => e.kind === 'cloud' && e.shared)
  const hasMac = macs.length > 0

  const [pickerOpen, setPickerOpen] = useState(false)
  const [dialog, setDialog] = useState<{ environment: EnvironmentItem | null } | null>(null)

  const [macDefault, setMacDefault] = useState<MacDefault>({ state: 'loading' })
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    if (!hasMac) return
    let live = true
    setMacDefault({ state: 'loading' })
    void readProjectMacDefault({ workspaceId, projectId }).then((r) => {
      if (live) setMacDefault(r.ok ? { state: 'ready', environmentId: r.value } : { state: 'unknown' })
    })
    return () => {
      live = false
    }
  }, [projectId, workspaceId, hasMac])

  const onId = macDefault.state === 'ready' ? macDefault.environmentId : null
  // The Mac it names, else your most recently online one.
  const mac = macs.find((m) => m.id === onId) ?? macs[0]
  const on = !!onId && !!mac && mac.id === onId

  async function toggle(next: boolean) {
    if (!mac || macDefault.state !== 'ready') return
    const was = macDefault
    setMacDefault({ state: 'ready', environmentId: next ? mac.id : null })
    setSwitching(true)
    const res = await setProjectMacDefault({ workspaceId, projectId, environmentId: next ? mac.id : null })
    setSwitching(false)
    if (res.ok) return
    // Refused (that Mac was removed, the project moved): back as it was, and the server says why.
    setMacDefault(was)
    toast.error(next ? `Couldn’t run your work here on ${mac.name}` : 'Couldn’t turn it off', { description: res.error })
  }

  const net = environmentNetworkAccess ? NETWORK_OPTIONS[environmentNetworkAccess] : null
  const NetIcon = net?.icon

  return (
    <div data-project-environment="">
      {environmentId ? (
        <div className="group flex items-center gap-2 px-2 py-1" data-project-environment-linked={environmentId}>
          <EnvironmentKindIcon kind="cloud" className="h-4 w-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{environmentName || 'Linked environment'}</span>
          {net && NetIcon && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <NetIcon className="h-3 w-3" />
              {net.label}
            </span>
          )}
          <button
            type="button"
            aria-label="Unlink environment"
            onClick={() => onLink(null)}
            className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <Popover
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open)
            if (open) void refreshEnvironments({ maxAgeMs: 2_000 })
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-project-environment-link=""
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
            >
              <EnvironmentKindIcon kind="cloud" className="h-4 w-4" />
              <span>Link environment</span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            <div className="max-h-64 overflow-y-auto p-1">
              {!list.loaded ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                  <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                </div>
              ) : shared.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">No shared cloud environments yet.</p>
              ) : (
                shared.map((env) => {
                  if (env.kind !== 'cloud') return null
                  const meta = NETWORK_OPTIONS[env.networkAccess]
                  const Icon = meta.icon
                  return (
                    <button
                      key={env.id}
                      type="button"
                      data-project-environment-option={env.id}
                      className="flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left text-xs hover:bg-muted/50"
                      onClick={() => {
                        onLink({ id: env.id, name: env.name, networkAccess: env.networkAccess })
                        setPickerOpen(false)
                      }}
                    >
                      <EnvironmentKindIcon kind="cloud" className="h-4 w-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium">{env.name}</span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </span>
                    </button>
                  )
                })
              )}
              <button
                type="button"
                data-project-environment-new=""
                className="mt-0.5 flex w-full items-center gap-2 rounded-2xl border-t px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
                onClick={() => {
                  setPickerOpen(false)
                  setDialog({ environment: null })
                }}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                New environment…
              </button>
            </div>
          </PopoverContent>
        </Popover>
      )}

      {hasMac && mac && macDefault.state !== 'unknown' && (
        <div data-project-run-on-mac={on ? 'on' : 'off'}>
          <div className="flex items-start gap-2 px-2 py-1">
            <EnvironmentKindIcon kind="mac" className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <label htmlFor={`run-on-mac-${projectId}`} className="min-w-0 flex-1 text-sm">
              <span className="block">Run my work here on</span>
              <span className="block truncate font-medium">{mac.name}</span>
            </label>
            <Switch
              id={`run-on-mac-${projectId}`}
              data-project-run-on-mac-switch=""
              checked={on}
              disabled={macDefault.state !== 'ready' || switching}
              onCheckedChange={(v) => void toggle(v)}
            />
          </div>
          <p className="px-2 pb-1 pl-8 text-xs text-muted-foreground">
            {on ? 'Actions you start here run on your Mac. Teammates’ run in the cloud.' : 'Actions you start here run in the cloud.'}
          </p>
          {on && githubRepo && !macLinksRepo(mac, githubRepo) && (
            <p data-project-run-on-mac-unlinked="" className="px-2 pb-1 pl-8 text-xs text-muted-foreground">
              No folder on {mac.name} is linked to <span className="font-mono">{githubRepo}</span>.{' '}
              <button
                type="button"
                data-project-link-folder=""
                onClick={() => setDialog({ environment: mac })}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                Link a folder
              </button>
            </p>
          )}
        </div>
      )}

      {dialog && (
        <EditEnvironmentDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          environment={dialog.environment}
          onSaved={(env) => {
            // A new shared one is linked at once; an "only me" one can't be.
            if (dialog.environment === null && env.kind === 'cloud' && env.shared) {
              onLink({ id: env.id, name: env.name, networkAccess: env.networkAccess })
            }
          }}
        />
      )}
    </div>
  )
}
