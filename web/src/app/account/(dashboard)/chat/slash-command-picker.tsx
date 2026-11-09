'use client'

import { useState, useEffect } from 'react'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { composerWorkspaceHeaders, useComposerWorkspace } from './composer-workspace'
import type { SkillCommand } from './chat-panel'
import { CommandMenu, type CommandMenuProps } from './command-menu'

/**
 * The workspace's skill commands, fetched once and shared by every chat.
 *
 * Each chat panel has its own composer, and a launch or a workspace switch
 * mounts several at once. Each one used to reset this cache — and the
 * in-flight guard with it — on mount and fetch again: a request per panel, and
 * a re-render of a whole chat panel per response, in the seconds right after
 * a switch. Now the panels of a workspace share one request, and one answer
 * serves any panel mounted within FRESH_MS of it. A new workspace fetches its
 * own, and a skill changed anywhere refetches (the entity sync below).
 */
const FRESH_MS = 60_000
/** A refetch (a skill changed) reaches every chat in the same moment; the ones
 *  asking within this window of each other share one request. */
const REFETCH_SHARE_MS = 250

/** The commands, and the request out for them, per workspace ('' for no workspace). */
const commandsCache = new Map<string, { commands: SkillCommand[]; at: number }>()
const inflight = new Map<string, { promise: Promise<SkillCommand[]>; at: number }>()

const COMMANDS_URL = '/api/account/skills/commands'

function cacheKey(workspaceId: string | null): string {
  return workspaceId ?? ''
}

function cachedCommands(workspaceId: string | null): SkillCommand[] | null {
  return commandsCache.get(cacheKey(workspaceId))?.commands ?? null
}

/**
 * The commands of `override` (a composer's own workspace, ComposerWorkspaceContext),
 * else of the window's. Shared per workspace: one answer serves FRESH_MS, one
 * request serves everyone asking while it's out.
 */
function loadCommands(force = false, override: string | null = null): Promise<SkillCommand[]> {
  const workspaceId = override ?? getClientWorkspaceId()
  const key = cacheKey(workspaceId)
  const now = Date.now()
  const cached = commandsCache.get(key)
  if (!force && cached && now - cached.at < FRESH_MS) {
    return Promise.resolve(cached.commands)
  }
  const flying = inflight.get(key)
  if (flying && (!force || now - flying.at < REFETCH_SHARE_MS)) {
    return flying.promise
  }
  // A composer's own workspace is named on the request; the window's is the
  // fetch interceptor's to name, as before.
  const request = override ? fetch(COMMANDS_URL, { headers: composerWorkspaceHeaders(override) }) : fetch(COMMANDS_URL)
  const promise: Promise<SkillCommand[]> = request
    .then((res) => res.json())
    .then((data: { commands?: SkillCommand[] }) => {
      const commands = data.commands || []
      commandsCache.set(key, { commands, at: Date.now() })
      return commands
    })
    .finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key)
    })
  inflight.set(key, { promise, at: now })
  return promise
}

/**
 * The skill commands of the composer's workspace (ComposerWorkspaceContext;
 * the window's when there's none): one shared fetch (see loadCommands).
 */
export function useRecipeCommands() {
  const override = useComposerWorkspace()
  const [commands, setCommands] = useState<SkillCommand[]>(() => cachedCommands(override ?? getClientWorkspaceId()) ?? [])

  useEffect(() => {
    let live = true
    loadCommands(false, override).then(
      (cmds) => {
        if (live) setCommands(cmds)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [override])

  // A skill created/renamed/deleted anywhere (another tab, an MCP tool, a
  // teammate) must reach an already-mounted consumer — the module cache would
  // otherwise serve stale commands until a full reload.
  useEntityListSync(['recipe'], () => {
    loadCommands(true, override).then(setCommands, () => {})
  })

  return commands
}

const NO_SKILLS: readonly SkillCommand[] = []

export interface SlashCommandPickerProps extends Omit<CommandMenuProps, 'skills' | 'onSelectSkill'> {
  /** A skill picked. */
  onSelect: (recipe: SkillCommand) => void
}

/**
 * The composer's menu (`/` and `@`; command-menu.tsx), with the workspace's
 * skills: the shared read (loadCommands) each time it opens, and again when a
 * skill changes anywhere while it's open.
 */
export function SlashCommandPicker({ onSelect, ...props }: SlashCommandPickerProps) {
  // A host's own `@` list lists no skills: none are read for it.
  const open = props.open && !props.mentionList
  const override = useComposerWorkspace()
  const [commands, setCommands] = useState<SkillCommand[]>(() => cachedCommands(override ?? getClientWorkspaceId()) ?? [])

  // The workspace's commands each time it opens (the shared read — see
  // loadCommands).
  useEffect(() => {
    if (!open) return
    let live = true
    loadCommands(false, override).then(
      (cmds) => {
        if (live) setCommands(cmds)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [open, override])

  // Refetch on any recipe change so the open menu reflects skills created via
  // MCP / another tab / a teammate — and the next open finds them too (the
  // refetch replaces the shared cache).
  useEntityListSync(['recipe'], () => {
    if (open) loadCommands(true, override).then(setCommands, () => {})
  })

  return <CommandMenu {...props} skills={props.mentionList ? NO_SKILLS : commands} onSelectSkill={onSelect} />
}
