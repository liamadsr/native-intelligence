'use client'

/**
 * Customize on a bot's page (docs/plans/bots-v4.md, "A bot's page" → About):
 * the one agent editor (Phase B1, `AgentEditorDialog` in
 * src/components/agents/agent-editor.tsx), opened on this bot in its own
 * workspace. `useAgentEditor` is the seam: About calls `open` and renders
 * `editor`.
 *
 * The editor covers every kind of bot (editable-fields.ts): a custom agent's
 * (its agent's instructions, tools and skills, and the bot's name, face, team
 * and limits), a role teammate (the same, on its role's persona), a system
 * teammate (its name, face and skills) and a loop's work bot (its name and
 * face, with the loops it speaks for). So Customize opens nothing else: the
 * Personas dialog, the Teams page and the loop's editor it went to before B1
 * are gone from here.
 *
 * The editor is loaded when Customize is pressed: a bot's page doesn't carry it.
 */
import { Suspense, lazy, useState, type ReactNode } from 'react'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import type { TeammateAbout } from '@/lib/work/teammate-about'

const AgentEditorDialog = lazy(() => import('@/components/agents/agent-editor').then((m) => ({ default: m.AgentEditorDialog })))

/** Which kind of bot it is, as the one editor tells them apart (bots-v4.md, "One agent, made in one place"). */
export type BotKind = 'custom' | 'role' | 'system' | 'loop'

/** The bot Customize opens the editor on. */
export interface AgentEditorTarget {
  /** The editor's `teammateId`. */
  teammateId: string
  /** The editor's `workspaceId`: the bot's own workspace. */
  workspaceId: string
  /** Which kind of bot it is (About shows a loop's work bot no skills of its own). */
  kind: BotKind
}

/**
 * Which kind of bot a teammate is: one built on a custom agent (its page's
 * read names the agent: teammate-about.ts), a loop's work bot (`fronts_only`
 * and no agent), a system teammate, else a teammate on a team, in a role.
 */
export function botKind(teammate: Pick<RosterTeammate, 'fronts_only' | 'is_system'>, agent: TeammateAbout['agent']): BotKind {
  if (agent) return 'custom'
  if (teammate.fronts_only) return 'loop'
  if (teammate.is_system) return 'system'
  return 'role'
}

/** The target for a teammate: its roster entry and its page's About read. */
export function agentEditorTarget(
  teammate: Pick<RosterTeammate, 'id' | 'workspace_id' | 'fronts_only' | 'is_system'>,
  about: Pick<TeammateAbout, 'agent'>,
): AgentEditorTarget {
  return {
    teammateId: teammate.id,
    workspaceId: teammate.workspace_id,
    kind: botKind(teammate, about.agent),
  }
}

export interface AgentEditorSeam {
  /** Opens the editor on the target. */
  open: () => void
  /** What to render for it: the editor while it's open, else nothing. */
  editor: ReactNode
}

/** Customize's editor for `target` (null while its page hasn't loaded it). */
export function useAgentEditor(target: AgentEditorTarget | null): AgentEditorSeam {
  const [opened, setOpened] = useState(false)
  const open = () => {
    if (target) setOpened(true)
  }
  const editor =
    opened && target ? (
      <Suspense fallback={null}>
        <AgentEditorDialog open teammateId={target.teammateId} workspaceId={target.workspaceId} onClose={() => setOpened(false)} />
      </Suspense>
    ) : null
  return { open, editor }
}
