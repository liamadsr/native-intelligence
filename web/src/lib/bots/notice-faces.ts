'use client'

/**
 * Whose face a notice wears (bots v3 1b). A notification that names a
 * teammate (bot-notice.ts) speaks as its bot: the banner's payload carries
 * the face. The notifications sit outside the shell's shared source
 * (NotificationProvider wraps AgentWorkProvider), so the shell's agent host
 * (agent-infra-host.tsx) publishes here who wears what (`publishNoticeFaces`,
 * from the roster), and the notices read it.
 *
 * One face (docs/plans/always-on-agent.md §2c): a notice an area face wrote
 * (Captures, Mail, …: attribution only now) speaks as the agent, its
 * workspace's Assistant: the agent's face, its name (the person's assistant
 * name, which the roster carries on the client: AgentWorkProvider)
 * (`noticeSpeakerOf`). The server writes the
 * area face's name on the row, and can't see a device-only name, so the
 * client re-titles it here.
 *
 * Module state: one roster per page. Nothing published yet reads as no face,
 * and every caller then does what it did before (the app's own notice).
 */
import type { BotCharacterType } from '@/lib/bots/bot-faces'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { agentTeammateIdFor, isAreaFaceTeammate } from './agent-face'
import { asBotCharacter } from './teammate-faces'

let faces: ReadonlyMap<string, BotCharacterType> = new Map()
/** An area face's notices speak as its workspace's Assistant (one face): by the area face's id, the agent's id and name. */
let speakers: ReadonlyMap<string, { teammateId: string; name: string }> = new Map()

type NoticeRosterEntry = Pick<RosterTeammate, 'id' | 'bot_character'> & Partial<Pick<RosterTeammate, 'workspace_id' | 'is_system' | 'system_key' | 'name'>>

/**
 * Who wears what, off the roster: a teammate with no face (or one the app
 * doesn't know) has none. An area face wears its workspace's Assistant's
 * face, and speaks as it (one face).
 */
export function publishNoticeFaces(roster: ReadonlyArray<NoticeRosterEntry>): void {
  const next = new Map<string, BotCharacterType>()
  const nextSpeakers = new Map<string, { teammateId: string; name: string }>()
  const byId = new Map(roster.map((t) => [t.id, t]))
  for (const teammate of roster) {
    if (isAreaFaceTeammate(teammate)) {
      const agentId = agentTeammateIdFor(roster, teammate.id)
      const agent = agentId !== teammate.id ? byId.get(agentId) : undefined
      if (!agent) continue
      const face = asBotCharacter(agent.bot_character)
      if (face) next.set(teammate.id, face)
      nextSpeakers.set(teammate.id, { teammateId: agent.id, name: agent.name?.trim() || 'Assistant' })
      continue
    }
    const face = asBotCharacter(teammate.bot_character)
    if (face) next.set(teammate.id, face)
  }
  const sameFaces = next.size === faces.size && [...next].every(([id, face]) => faces.get(id) === face)
  const sameSpeakers =
    nextSpeakers.size === speakers.size &&
    [...nextSpeakers].every(([id, s]) => speakers.get(id)?.teammateId === s.teammateId && speakers.get(id)?.name === s.name)
  if (!sameFaces) faces = next
  if (!sameSpeakers) speakers = nextSpeakers
}

/** The face `teammateId`'s bot wears, or null (unknown teammate, no face, nothing published yet). */
export function noticeFaceOf(teammateId: string | null | undefined): BotCharacterType | null {
  return teammateId ? (faces.get(teammateId) ?? null) : null
}

/**
 * Who a notice naming `teammateId` speaks as, when that isn't the teammate
 * itself: an area face's notice speaks as its workspace's Assistant (one
 * face), by its id (whose stack its banner joins) and name (the banner's and
 * the toast's title). Null for any other teammate, or nothing published yet.
 */
export function noticeSpeakerOf(teammateId: string | null | undefined): { teammateId: string; name: string } | null {
  return teammateId ? (speakers.get(teammateId) ?? null) : null
}

/** Tests only: nobody published. */
export function __resetNoticeFacesForTests(): void {
  faces = new Map()
  speakers = new Map()
}
