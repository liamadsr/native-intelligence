'use client'

/**
 * The side panel's Environment card: where the main chat's work runs (docs/
 * plans/environments.md §6), after Claude desktop's sidebar "Environment"
 * card. Its card and its "Environment" row are the panel's (side-panels.tsx
 * PanelSection); the row's summary is the environment's name. Opened, plain
 * rows like the Connectors card's:
 *
 *   the environment   its kind's mark (a laptop, a cloud), its name, online /
 *                     offline for a Mac, and a gear that opens Edit
 *                     environment;
 *   a Mac's folder    a folder mark, its name ` · ~/its/parent` (the person's
 *                     own view: the full path on hover; never shown to a
 *                     model), its mode ("edits" or "read only", the grant's),
 *                     its base branch once that Mac's app supports one, and ×
 *                     to remove it (the desktop app, a folder on this Mac);
 *   a branch          under its folder: an edit job's `dial8/…` branch, live
 *                     or from the last 7 days, cut in the middle, "Worktree";
 *                     a click copies the name;
 *   cloud             the network level and what it reaches.
 *
 * Then, for a Mac, Add folder… (the desktop app on that Mac: the composer's
 * own pick flow), or a line saying folders are added on that Mac. No
 * environment for the chat: the panel shows no card at all (hide empty
 * widgets).
 *
 * The data: the chat's environment (GET /api/account/environments/chat, read
 * once per conversation and when the panel opens), and for a Mac the shared
 * local-agent store (paths, live branches), read every 30 s while the panel
 * is open and the page visible. Nothing else on a timer, no animation.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Folder, GitBranch, Loader2, Plus, Settings2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'
import {
  CHAT_ENVIRONMENT_FRESH_MS,
  addEnvironmentFolder,
  folderParent,
  refreshChatEnvironment,
  refreshEnvironments,
  removeEnvironmentFolder,
  truncateMiddle,
  useChatEnvironment,
  useLocalEnvironment,
  type EnvironmentItem,
  type EnvironmentSnapshot,
  type EnvironmentWorktree,
  type MacEnvironmentItem,
} from '@/lib/local-agent/environment-client'
import type { FolderMode } from '@/lib/environments/types'
import { EditEnvironmentDialog } from '@/components/environments/edit-environment-dialog'
import { EnvironmentKindIcon, NETWORK_OPTIONS, OnlineDot } from '@/components/environments/environment-meta'

/** A branch name this long at most, cut in the middle. */
export const BRANCH_MAX_CHARS = 26

/** What the card shows: the chat's environment, and for a Mac the store with its folders' paths and branches. */
export interface EnvironmentCard {
  environment: EnvironmentItem
  local: EnvironmentSnapshot
  summary: string
}

/** The card's row summary: the environment's name. */
export function environmentSummary(environment: Pick<EnvironmentItem, 'name'>): string {
  return environment.name
}

/**
 * The main chat's environment, for the card: null while it has none (or
 * before the first read), so the panel shows no card. `open`: the panel is
 * open (the Mac's folders are read every 30 s meanwhile).
 */
export function useEnvironmentCard({ open, conversationId }: { open: boolean; conversationId: string | null }): EnvironmentCard | null {
  const chat = useChatEnvironment(conversationId)
  const isMac = chat.environment?.kind === 'mac'
  const local = useLocalEnvironment({ poll: open && isMac })
  // Opening the panel reads where the chat runs again, unless that was just read.
  useEffect(() => {
    if (open && conversationId) void refreshChatEnvironment(conversationId, { maxAgeMs: CHAT_ENVIRONMENT_FRESH_MS })
  }, [open, conversationId])
  const environment = chat.environment
  return useMemo(() => (environment ? { environment, local, summary: environmentSummary(environment) } : null), [environment, local])
}

/** One of a Mac's folders on the card: the server's settings, and the person's own path when the store has it. */
export interface CardFolder {
  id: string
  label: string
  mode: FolderMode
  /** The full path (the person's own view), or '' before the store has it. */
  path: string
  isGit: boolean
  baseBranch: string | null
  /** This Mac's own (the × removes it here). */
  deviceId: string
}

/**
 * A Mac's folders with their branches: the store's (live, polled) once it has
 * read, each with the server's base branch; before that, the environment's.
 */
export function macFolders(
  mac: MacEnvironmentItem,
  local: Pick<EnvironmentSnapshot, 'loaded' | 'folders' | 'worktrees'>,
): Array<{ folder: CardFolder; worktrees: EnvironmentWorktree[] }> {
  const settings = new Map(mac.folders.map((f) => [f.id, f]))
  const folders: CardFolder[] = local.loaded
    ? local.folders
        .filter((f) => f.deviceId === mac.deviceId)
        .map((f) => ({ id: f.id, label: f.label, mode: f.mode, isGit: f.isGit, path: f.path, baseBranch: settings.get(f.id)?.baseBranch ?? null, deviceId: f.deviceId }))
    : mac.folders.map((f) => ({ id: f.id, label: f.label, mode: f.mode, isGit: f.isGit, path: '', baseBranch: f.baseBranch, deviceId: mac.deviceId }))
  const byFolder = new Map<string, EnvironmentWorktree[]>()
  for (const w of local.worktrees) byFolder.set(w.folderId, [...(byFolder.get(w.folderId) ?? []), w])
  return folders.map((folder) => ({ folder, worktrees: byFolder.get(folder.id) ?? [] }))
}

const ROW = 'flex h-9 items-center gap-2.5 px-3'
const ICON = 'flex size-6 shrink-0 items-center justify-center text-muted-foreground'
const CHIP = 'shrink-0 rounded-sm border border-border/70 px-1 text-[10px] font-medium leading-4 text-muted-foreground'

export function EnvironmentSection({ card }: { card: EnvironmentCard }) {
  const { environment, local } = card
  const [editing, setEditing] = useState(false)
  return (
    // The card, its row and its body's box are the panel's (side-panels.tsx PanelSection).
    <div data-environment-section="" data-environment-kind={environment.kind}>
      <EnvironmentRow environment={environment} local={local} onEdit={() => setEditing(true)} />
      {environment.kind === 'mac' ? <MacBody mac={environment} local={local} /> : <CloudBody environment={environment} />}
      {editing && (
        <EditEnvironmentDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false)
          }}
          environment={environment}
        />
      )}
    </div>
  )
}

const EnvironmentRow = memo(function EnvironmentRow({
  environment,
  local,
  onEdit,
}: {
  environment: EnvironmentItem
  local: EnvironmentSnapshot
  onEdit: () => void
}) {
  const online = environment.kind === 'mac' ? (local.devices.find((d) => d.id === environment.deviceId)?.online ?? environment.online) : null
  return (
    <div className={ROW} data-environment-row="">
      <span className={ICON}>
        <EnvironmentKindIcon kind={environment.kind} className="size-3.5" />
      </span>
      <span data-environment-name="" className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {environment.name}
      </span>
      {online !== null && (
        <span data-environment-online={online ? 'online' : 'offline'} className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <OnlineDot online={online} />
          {online ? 'Online' : 'Offline'}
        </span>
      )}
      <button
        type="button"
        data-environment-edit=""
        aria-label={`Edit ${environment.name}`}
        title="Edit environment"
        onClick={onEdit}
        className="-mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <Settings2 aria-hidden className="size-3.5" />
      </button>
    </div>
  )
})

function MacBody({ mac, local }: { mac: MacEnvironmentItem; local: EnvironmentSnapshot }) {
  const folders = useMemo(() => macFolders(mac, local), [mac, local])
  const onThisMac = local.canEdit && !!local.thisDeviceId && local.thisDeviceId === mac.deviceId
  const add = async () => {
    await addEnvironmentFolder()
    // The chat's Mac lists the new folder (and its settings) on the next read.
    await refreshEnvironments({ force: true })
  }
  return (
    <>
      {folders.length > 0 && (
        <ul>
          {folders.map(({ folder, worktrees }) => (
            <li key={folder.id}>
              <FolderRow
                folder={folder}
                showBase={mac.supportsBaseBranch}
                removable={onThisMac && folder.deviceId === local.thisDeviceId}
                removing={local.removing.includes(folder.id)}
              />
              {worktrees.length > 0 && (
                <ul>
                  {worktrees.map((w) => (
                    <WorktreeRow key={w.sessionId} worktree={w} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {onThisMac ? (
        <button
          type="button"
          data-environment-add=""
          disabled={local.picking}
          aria-busy={local.picking || undefined}
          onClick={() => void add()}
          className="mx-1.5 mt-0.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none"
        >
          {local.picking ? <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden className="size-3" />}
          Add folder…
        </button>
      ) : (
        <p data-environment-hint="" className="px-3 pb-1 pt-1 text-xs text-muted-foreground">
          {folders.length === 0 ? `No folders yet. Add them in Dial8 on ${mac.name}.` : `Add folders in Dial8 on ${mac.name}.`}
        </p>
      )}
    </>
  )
}

function CloudBody({ environment }: { environment: Extract<EnvironmentItem, { kind: 'cloud' }> }) {
  const net = NETWORK_OPTIONS[environment.networkAccess]
  const NetIcon = net.icon
  return (
    <div className={ROW} data-environment-network={environment.networkAccess}>
      <span className={ICON}>
        <NetIcon aria-hidden className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{net.label} network</span>
      <span className="shrink-0 text-[12px] text-muted-foreground">{net.short}</span>
    </div>
  )
}

const FolderRow = memo(function FolderRow({
  folder,
  showBase,
  removable,
  removing,
}: {
  folder: CardFolder
  showBase: boolean
  removable: boolean
  removing: boolean
}) {
  const parent = folderParent(folder.path)
  return (
    <div className={ROW} data-environment-folder={folder.id} title={folder.path || undefined}>
      <span className={ICON}>
        <Folder aria-hidden className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="text-foreground">{folder.label}</span>
        {parent && <span className="text-muted-foreground"> · {parent}</span>}
      </span>
      {showBase && folder.mode === 'edit' && folder.isGit && folder.baseBranch && (
        <span
          data-environment-base={folder.baseBranch}
          title={`Edit jobs branch from ${folder.baseBranch}`}
          className="inline-flex max-w-[6rem] shrink-0 items-center gap-0.5 font-mono text-[11px] text-muted-foreground"
        >
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{folder.baseBranch}</span>
        </span>
      )}
      <span data-environment-mode={folder.mode} className={CHIP}>
        {folder.mode === 'edit' ? 'edits' : 'read only'}
      </span>
      {removable && (
        <button
          type="button"
          data-environment-remove={folder.id}
          disabled={removing}
          aria-busy={removing || undefined}
          aria-label={`Remove ${folder.label} from your environment`}
          title="Remove from your environment"
          onClick={() => void removeEnvironmentFolder(folder.id)}
          className="-mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  )
})

const WorktreeRow = memo(function WorktreeRow({ worktree }: { worktree: EnvironmentWorktree }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyTextToClipboard(worktree.branch)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <li>
      <button
        type="button"
        data-environment-worktree={worktree.branch}
        aria-label={copied ? `Copied ${worktree.branch}` : `Copy branch ${worktree.branch}`}
        title={worktree.branch}
        onClick={() => void copy()}
        className={cn(ROW, 'w-full pl-8 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none rounded-md')}
      >
        <span className={ICON}>
          <GitBranch aria-hidden className={cn('size-3.5', worktree.live && 'text-emerald-600 dark:text-emerald-400')} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{truncateMiddle(worktree.branch, BRANCH_MAX_CHARS)}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">{copied ? 'Copied' : 'Worktree'}</span>
      </button>
    </li>
  )
})
