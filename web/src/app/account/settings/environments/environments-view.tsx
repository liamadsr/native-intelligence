'use client'

/**
 * Settings → Environments (docs/plans/environments.md §6): every place your
 * agents' work can run, in one list. Your Macs first (shown only when you
 * have one), then the workspace's cloud environments you can see, with New,
 * Edit (Edit environment, components/environments/edit-environment-dialog.tsx)
 * and Archive. A cloud environment you can't change opens read-only, its env
 * vars and setup script masked.
 *
 * The data is the shared environments store (src/lib/local-agent/
 * environment-client.ts), read when the page opens and after an edit.
 */
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Plus, Settings2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EditEnvironmentDialog } from '@/components/environments/edit-environment-dialog'
import { EnvironmentKindIcon, NETWORK_OPTIONS, OnlineDot } from '@/components/environments/environment-meta'
import { archiveEnvironment } from '@/components/environments/api'
import {
  forgetEnvironment,
  useEnvironments,
  type EnvironmentItem,
  type MacEnvironmentItem,
} from '@/lib/local-agent/environment-client'
import type { CloudEnvironment } from '@/lib/environments/types'

/** The dialog: an environment to edit, or a new cloud one. */
type Editing = { environment: EnvironmentItem | null } | null

export function EnvironmentsView() {
  const { loaded, environments } = useEnvironments()
  const macs = environments.filter((e): e is MacEnvironmentItem => e.kind === 'mac')
  const clouds = environments.filter((e): e is CloudEnvironment => e.kind === 'cloud')
  const [editing, setEditing] = useState<Editing>(null)
  const [archiving, setArchiving] = useState<CloudEnvironment | null>(null)
  const [isArchiving, setIsArchiving] = useState(false)

  async function confirmArchive() {
    if (!archiving) return
    setIsArchiving(true)
    try {
      const res = await archiveEnvironment(archiving.id)
      // In use by a project or as the workspace default, or not yours: the server says which.
      if (res.ok) forgetEnvironment(archiving.id)
      else toast.error('Couldn’t archive the environment', { description: res.error })
      setArchiving(null)
    } finally {
      setIsArchiving(false)
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <Link
          href="/account/settings"
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Preferences
        </Link>
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Environments</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Where your agents’ work runs: on one of your Macs, or in a cloud sandbox with its own network, environment variables
              and setup script. Each chat picks one under its message box.
            </p>
          </div>
          <Button size="sm" data-environments-new="" onClick={() => setEditing({ environment: null })} className="shrink-0">
            <Plus className="mr-1 h-3.5 w-3.5" /> New
          </Button>
        </div>

        <Separator className="my-6" />

        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-8">
            {macs.length > 0 && (
              <section data-environments-section="macs" aria-labelledby="environments-macs">
                <h2 id="environments-macs" className="mb-2 text-[13px] font-medium text-muted-foreground">
                  Your Macs
                </h2>
                <div className="space-y-2">
                  {macs.map((mac) => (
                    <MacRow key={mac.id} mac={mac} onEdit={() => setEditing({ environment: mac })} />
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Only you see your Macs. Their folders are shared from the Dial8 desktop app.</p>
              </section>
            )}

            <section data-environments-section="cloud" aria-labelledby="environments-cloud">
              <h2 id="environments-cloud" className="mb-2 text-[13px] font-medium text-muted-foreground">
                Cloud
              </h2>
              {clouds.length === 0 ? (
                <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-10 text-center">
                  <EnvironmentKindIcon kind="cloud" className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">No cloud environments yet</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Make one to give cloud runs a network level, environment variables and a setup script.
                  </p>
                  <Button size="sm" variant="outline" className="mt-4" onClick={() => setEditing({ environment: null })}>
                    <Plus className="mr-1 h-3.5 w-3.5" /> New cloud environment
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {clouds.map((env) => (
                    <CloudRow key={env.id} env={env} onEdit={() => setEditing({ environment: env })} onArchive={() => setArchiving(env)} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {editing && (
        <EditEnvironmentDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          environment={editing.environment}
        />
      )}

      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive environment?"
        description={archiving ? archiveDescription(archiving) : ''}
        confirmLabel="Archive"
        busy={isArchiving}
        onConfirm={() => void confirmArchive()}
      />
    </ScrollArea>
  )
}

/** What archiving does, and what stops it (the server refuses an environment a project or the workspace default uses). */
export function archiveDescription(env: Pick<CloudEnvironment, 'name' | 'projectCount' | 'isWorkspaceDefault'>): string {
  const uses = [
    env.projectCount > 0 ? `${env.projectCount} ${env.projectCount === 1 ? 'project uses' : 'projects use'} it` : null,
    env.isWorkspaceDefault ? 'it is the workspace’s default' : null,
  ].filter(Boolean)
  return uses.length > 0
    ? `“${env.name}” can’t be archived while ${uses.join(' and ')}. Pick another environment for ${env.projectCount > 0 && env.isWorkspaceDefault ? 'them' : 'it'} first.`
    : `“${env.name}” leaves every list. Chats that used it move to the next default.`
}

const ROW_CLASS = 'group flex items-center gap-3 rounded-xl border px-4 py-3'
const MARK_CLASS = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted'

function MacRow({ mac, onEdit }: { mac: MacEnvironmentItem; onEdit: () => void }) {
  const n = mac.folders.length
  return (
    <div className={ROW_CLASS} data-environments-row={mac.id}>
      <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className={MARK_CLASS}>
          <EnvironmentKindIcon kind="mac" className="h-[18px] w-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{mac.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <OnlineDot online={mac.online} />
              {mac.online ? 'Online' : 'Offline'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {n === 0 ? 'No folders shared yet' : `${n} ${n === 1 ? 'folder' : 'folders'}: ${mac.folders.map((f) => f.label).join(', ')}`}
          </p>
        </div>
      </button>
      <EditButton label={`Edit ${mac.name}`} onClick={onEdit} />
    </div>
  )
}

function CloudRow({ env, onEdit, onArchive }: { env: CloudEnvironment; onEdit: () => void; onArchive: () => void }) {
  const net = NETWORK_OPTIONS[env.networkAccess]
  const NetIcon = net.icon
  const used = env.projectCount > 0 ? `Used by ${env.projectCount} ${env.projectCount === 1 ? 'project' : 'projects'}` : 'Not linked to any project'
  return (
    <div className={ROW_CLASS} data-environments-row={env.id}>
      <button
        type="button"
        onClick={onEdit}
        title={env.canEdit ? undefined : 'Only the person who made it or a workspace admin can change it'}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className={MARK_CLASS}>
          <EnvironmentKindIcon kind="cloud" className="h-[18px] w-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{env.name}</span>
            <Badge variant="outline" className={`h-5 shrink-0 gap-1 text-[10px] ${net.badgeClass}`}>
              <NetIcon className="h-2.5 w-2.5" />
              {net.label}
            </Badge>
            {env.isWorkspaceDefault && (
              <Badge variant="outline" data-environments-default="" className="h-5 shrink-0 text-[10px] text-muted-foreground">
                Workspace default
              </Badge>
            )}
            {!env.shared && (
              <Badge variant="outline" data-environments-only-me="" className="h-5 shrink-0 text-[10px] text-muted-foreground">
                Only me
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{used}</p>
        </div>
      </button>
      {env.canEdit && (
        <button
          type="button"
          onClick={onArchive}
          data-environments-archive={env.id}
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          title="Archive environment"
          aria-label={`Archive ${env.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <EditButton label={env.canEdit ? `Edit ${env.name}` : `View ${env.name}`} onClick={onEdit} />
    </div>
  )
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Settings2 className="h-3.5 w-3.5" />
    </button>
  )
}
