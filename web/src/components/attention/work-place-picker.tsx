'use client'

/**
 * Where a work card's Start runs (Liam, 10-23: "attach an environment to it
 * or a directory… then click Start, and that job should be kicked off inside
 * of that environment"): the card's control bar, bottom-left, as the
 * composer's environment selector reads (environments/environment-selector
 * .tsx): the place's mark, its name, a caret. Its menu:
 *
 *   Native Intelligence          the default: a Native Intelligence work run, the workspace agent and its
 *                  tools, no files (what Start always did);
 *   Your Macs      each Mac (its online dot), then its shared folders: the
 *                  Native Intelligence agent on that Mac does the work there, on a branch
 *                  where the folder allows edits and is a git repository,
 *                  reading only anywhere else. An offline Mac's folders can't
 *                  be picked;
 *   Cloud          each shared cloud environment of the card's workspace,
 *                  then the project repo to work on (a cloud environment
 *                  holds no repos): a coding run, which opens a pull request.
 *                  Only on a card of the window's workspace (the list is that
 *                  workspace's), and only "shared" ones (project work never
 *                  runs in an "only me" one).
 *
 * Nothing to pick but Native Intelligence (no shared folder, no shared cloud environment):
 * the picker isn't shown. The last pick is remembered per workspace in this
 * browser and is the next card's; a remembered place that's gone reads as
 * Native Intelligence. The server checks every id again, as the person's own.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Folder, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EnvironmentKindIcon, OnlineDot } from '@/components/environments/environment-meta'
import { refreshEnvironments, useEnvironments, type MacEnvironmentItem } from '@/lib/local-agent/environment-client'
import { isRepoFullName, type CloudEnvironment } from '@/lib/environments/types'
import type { WorkRunPlace } from '@/lib/attention/work-place'

/** The picked place, with what the trigger shows (the ids are what's sent). */
export type WorkPlaceChoice =
  | { kind: 'mac'; folderId: string; folder: string; mac: string }
  | { kind: 'cloud'; environmentId: string; environment: string; projectId: string; repo: string }

/** What a Start sends for a choice; null (Native Intelligence) sends nothing. */
export function runInOf(choice: WorkPlaceChoice | null): WorkRunPlace | null {
  if (!choice) return null
  return choice.kind === 'mac'
    ? { kind: 'mac', folder_id: choice.folderId }
    : { kind: 'cloud', environment_id: choice.environmentId, project_id: choice.projectId }
}

// ── The remembered pick (this browser, per workspace) ──────────────────────

const STORE_PREFIX = 'dial8:work-place:'

function readRemembered(workspaceId: string): WorkPlaceChoice | null {
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + workspaceId)
    const v = raw ? (JSON.parse(raw) as Partial<WorkPlaceChoice> | null) : null
    if (v?.kind === 'mac' && typeof v.folderId === 'string') {
      return { kind: 'mac', folderId: v.folderId, folder: String(v.folder ?? ''), mac: String(v.mac ?? '') }
    }
    if (v?.kind === 'cloud' && typeof v.environmentId === 'string' && typeof v.projectId === 'string') {
      return { kind: 'cloud', environmentId: v.environmentId, environment: String(v.environment ?? ''), projectId: v.projectId, repo: String(v.repo ?? '') }
    }
  } catch {
    // Storage off or unreadable: no remembered pick.
  }
  return null
}

function remember(workspaceId: string, choice: WorkPlaceChoice | null): void {
  try {
    if (choice) window.localStorage.setItem(STORE_PREFIX + workspaceId, JSON.stringify(choice))
    else window.localStorage.removeItem(STORE_PREFIX + workspaceId)
  } catch {
    // Storage off: the pick holds for this card only.
  }
}

// ── The workspace's project repos (read when the menu opens) ───────────────

export interface ProjectRepo {
  projectId: string
  project: string
  repo: string
}

const REPOS_FRESH_MS = 60_000
const repoCache = new Map<string, { at: number; repos: ProjectRepo[] }>()
const repoInflight = new Map<string, Promise<ProjectRepo[]>>()

/** A projects answer as the repos it names, a plain owner/repo only, sorted by project. */
export function parseProjectRepos(json: unknown): ProjectRepo[] {
  const rows = json && typeof json === 'object' && Array.isArray((json as { projects?: unknown }).projects) ? (json as { projects: unknown[] }).projects : []
  return rows
    .flatMap((r) => {
      if (!r || typeof r !== 'object') return []
      const p = r as { id?: unknown; name?: unknown; github_repo?: unknown }
      const repo = typeof p.github_repo === 'string' ? p.github_repo.trim() : ''
      if (typeof p.id !== 'string' || !isRepoFullName(repo)) return []
      return [{ projectId: p.id, project: typeof p.name === 'string' ? p.name : repo, repo }]
    })
    .sort((a, b) => a.project.localeCompare(b.project))
}

function loadProjectRepos(workspaceId: string): Promise<ProjectRepo[]> {
  const cached = repoCache.get(workspaceId)
  if (cached && Date.now() - cached.at < REPOS_FRESH_MS) return Promise.resolve(cached.repos)
  const running = repoInflight.get(workspaceId)
  if (running) return running
  const run = fetch('/api/account/projects?minimal=1', { headers: { 'x-workspace-id': workspaceId }, cache: 'no-store' })
    .then(async (res) => (res.ok ? parseProjectRepos(await res.json().catch(() => null)) : (cached?.repos ?? [])))
    .catch(() => cached?.repos ?? [])
    .then((repos) => {
      repoCache.set(workspaceId, { at: Date.now(), repos })
      return repos
    })
    .finally(() => repoInflight.delete(workspaceId))
  repoInflight.set(workspaceId, run)
  return run
}

// ── The picker ──────────────────────────────────────────────────────────────

export interface WorkPlaceState {
  /** The place a Start runs in now, as it stands against the list (null: Native Intelligence). */
  choice: WorkPlaceChoice | null
  pick: (choice: WorkPlaceChoice | null) => void
  places: ReturnType<typeof workPlaces>
  /** The environments list landed. */
  loaded: boolean
  /** There is something to pick but Native Intelligence (or a remembered place, before the list lands). */
  shown: boolean
}

/** The places a person can pick, from their environments list. */
export function workPlaces(environments: readonly (MacEnvironmentItem | CloudEnvironment)[], cloudHere: boolean) {
  const macs = environments.filter((e): e is MacEnvironmentItem => e.kind === 'mac' && e.folders.length > 0)
  const clouds = cloudHere ? environments.filter((e): e is CloudEnvironment => e.kind === 'cloud' && e.shared && !e.archivedAt) : []
  return { macs, clouds }
}

/**
 * The choice as it stands against the list: a remembered folder that's gone,
 * an offline Mac's, or a cloud environment no longer listed, reads as Native Intelligence.
 * While the list hasn't loaded, the choice stands (the server checks it).
 */
export function liveChoice(choice: WorkPlaceChoice | null, places: ReturnType<typeof workPlaces>, loaded: boolean): WorkPlaceChoice | null {
  if (!choice || !loaded) return choice
  if (choice.kind === 'mac') {
    const mac = places.macs.find((m) => m.folders.some((f) => f.id === choice.folderId))
    return mac?.online ? choice : null
  }
  return places.clouds.some((c) => c.id === choice.environmentId) ? choice : null
}

/**
 * A work card's place: the remembered pick for its workspace (read once the
 * card mounts), checked against the environments list (the composer's store:
 * one read for every card on screen). `windowWorkspaceId`: the cloud
 * environments listed are that workspace's, so only a card of it offers them.
 * Off (not a work card): nothing read, nothing shown.
 */
export function useWorkPlace({ workspaceId, windowWorkspaceId, enabled }: { workspaceId: string; windowWorkspaceId: string | null; enabled: boolean }): WorkPlaceState {
  const list = useEnvironments({ enabled })
  const cloudHere = !!windowWorkspaceId && windowWorkspaceId === workspaceId
  const places = useMemo(() => workPlaces(list.environments, cloudHere), [list.environments, cloudHere])
  const [remembered, setRemembered] = useState<WorkPlaceChoice | null>(null)
  useEffect(() => {
    if (enabled) setRemembered(readRemembered(workspaceId))
  }, [enabled, workspaceId])
  const pick = (next: WorkPlaceChoice | null) => {
    setRemembered(next)
    remember(workspaceId, next)
  }
  const choice = liveChoice(remembered, places, list.loaded)
  const any = places.macs.length > 0 || places.clouds.length > 0
  return { choice, pick, places, loaded: list.loaded, shown: enabled && (list.loaded ? any : !!remembered) }
}

export function WorkPlacePicker({ state, workspaceId, disabled }: { state: WorkPlaceState; workspaceId: string; disabled?: boolean }) {
  const { places, choice: current, pick: onChange } = state
  const [open, setOpen] = useState(false)
  const [repos, setRepos] = useState<ProjectRepo[] | null>(null)

  // The repos only matter once the menu is open, and only with a cloud environment to run them in.
  useEffect(() => {
    if (!open || places.clouds.length === 0) return
    let live = true
    void loadProjectRepos(workspaceId).then((r) => {
      if (live) setRepos(r)
    })
    return () => {
      live = false
    }
  }, [open, places.clouds.length, workspaceId])

  // Nothing to pick but Native Intelligence: no picker. (Before the list lands, a remembered place still shows.)
  if (!state.shown) return null

  const radioValue = current ? (current.kind === 'mac' ? `mac:${current.folderId}` : `cloud:${current.environmentId}:${current.projectId}`) : 'dial8'
  // A cloud run names its repo too (the environment holds none): "Default · dial8-website".
  const repoName = current?.kind === 'cloud' ? current.repo.split('/').pop() || '' : ''
  const label = !current
    ? 'Native Intelligence'
    : current.kind === 'mac'
      ? current.folder || 'Folder'
      : [current.environment || 'Cloud', repoName].filter(Boolean).join(' · ')
  const title = !current
    ? 'Runs in Native Intelligence with your workspace’s tools. Pick a folder on your Mac or a cloud environment instead.'
    : current.kind === 'mac'
      ? `Runs on ${current.mac || 'your Mac'}, in ${current.folder || 'that folder'}`
      : `Runs in the cloud, ${current.environment || 'its environment'}${current.repo ? `, on ${current.repo}` : ''}`

  const pickMac = (mac: MacEnvironmentItem, folderId: string) => {
    const folder = mac.folders.find((f) => f.id === folderId)
    if (folder) onChange({ kind: 'mac', folderId, folder: folder.label, mac: mac.name })
  }
  const pickCloud = (env: CloudEnvironment, r: ProjectRepo) => {
    onChange({ kind: 'cloud', environmentId: env.id, environment: env.name, projectId: r.projectId, repo: r.repo })
    setOpen(false)
  }

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void refreshEnvironments({ maxAgeMs: 5_000 })
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-work-place={current?.kind ?? 'dial8'}
          aria-label={`Where this runs: ${label}`}
          title={title}
          className="flex h-6 min-w-0 max-w-[13rem] shrink items-center gap-1 overflow-hidden rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground motion-reduce:transition-none"
        >
          <PlaceIcon choice={current} className="size-3" />
          <span data-work-place-name="" className="min-w-0 truncate">
            {label}
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" data-work-place-menu="" aria-label="Where this runs" className="w-72">
        <DropdownMenuRadioGroup
          value={radioValue}
          onValueChange={(v) => {
            if (v === 'dial8') return onChange(null)
            const [kind, id] = v.split(':')
            if (kind !== 'mac') return
            const mac = places.macs.find((m) => m.folders.some((f) => f.id === id))
            if (mac) pickMac(mac, id)
          }}
        >
          <PlaceRow value="dial8" selected={!current} icon={<Sparkles aria-hidden className="size-4 shrink-0 text-muted-foreground" />} name="Native Intelligence" hint="Workspace tools, no files" />
          {places.macs.map((mac) => (
            <div key={mac.id} role="group" aria-label={mac.name}>
              <DropdownMenuSeparator className="mx-0 my-1" />
              <MenuHeading>
                <span className="min-w-0 truncate">{mac.name}</span>
                <OnlineDot online={mac.online} />
                {!mac.online && <span className="font-normal">Offline</span>}
              </MenuHeading>
              {mac.folders.map((f) => (
                <PlaceRow
                  key={f.id}
                  value={`mac:${f.id}`}
                  selected={current?.kind === 'mac' && current.folderId === f.id}
                  disabled={!mac.online}
                  icon={<Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                  name={f.label}
                  hint={f.mode === 'edit' && f.isGit ? 'Edits on a branch' : 'Read only'}
                />
              ))}
            </div>
          ))}
        </DropdownMenuRadioGroup>
        {places.clouds.length > 0 && (
          <>
            <DropdownMenuSeparator className="mx-0 my-1" />
            <MenuHeading>Cloud</MenuHeading>
            {places.clouds.map((env) => (
              <DropdownMenuSub key={env.id}>
                <DropdownMenuSubTrigger data-work-place-cloud={env.id} className="gap-2.5 py-2 text-sm">
                  <EnvironmentKindIcon kind="cloud" className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{env.name}</span>
                  {current?.kind === 'cloud' && current.environmentId === env.id && (
                    <>
                      <Check aria-hidden className="size-4 shrink-0" />
                      <span className="sr-only">(selected)</span>
                    </>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64 p-1.5" data-work-place-repos={env.id}>
                  <MenuHeading>Repository</MenuHeading>
                  {repos === null ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-[13px] text-muted-foreground">
                      <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
                      Loading…
                    </div>
                  ) : repos.length === 0 ? (
                    <div className="px-2 py-2 text-[12px] text-muted-foreground">No project here has a GitHub repository.</div>
                  ) : (
                    // A radio group, so the repo it runs on reads as the checked one.
                    <DropdownMenuRadioGroup
                      value={radioValue}
                      aria-label={`Repositories for ${env.name}`}
                      onValueChange={(v) => {
                        const r = repos.find((x) => `cloud:${env.id}:${x.projectId}` === v)
                        if (r) pickCloud(env, r)
                      }}
                    >
                      {repos.map((r) => (
                        <DropdownMenuPrimitive.RadioItem
                          key={r.projectId}
                          value={`cloud:${env.id}:${r.projectId}`}
                          data-work-place-repo={r.projectId}
                          className="relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{r.project}</span>
                            <span className="block truncate text-[12px] text-muted-foreground">{r.repo}</span>
                          </span>
                          <DropdownMenuPrimitive.ItemIndicator>
                            <Check aria-hidden className="size-4 shrink-0" />
                          </DropdownMenuPrimitive.ItemIndicator>
                        </DropdownMenuPrimitive.RadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </>
        )}
        {!state.loaded && (
          <div className="flex items-center gap-2 px-2 py-2 text-[13px] text-muted-foreground">
            <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading…
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PlaceIcon({ choice, className }: { choice: WorkPlaceChoice | null; className?: string }) {
  if (!choice) return <Sparkles aria-hidden className={cn('shrink-0', className)} />
  if (choice.kind === 'mac') return <Folder aria-hidden className={cn('shrink-0', className)} />
  return <EnvironmentKindIcon kind="cloud" className={className} />
}

function MenuHeading({ children }: { children: ReactNode }) {
  return <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{children}</DropdownMenuLabel>
}

function PlaceRow({ value, selected, disabled, icon, name, hint }: { value: string; selected: boolean; disabled?: boolean; icon: ReactNode; name: string; hint: string }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      value={value}
      disabled={disabled}
      data-work-place-option={value}
      className="relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{hint}</span>
      </span>
      {selected && <Check aria-hidden className="size-4 shrink-0" />}
    </DropdownMenuPrimitive.RadioItem>
  )
}
