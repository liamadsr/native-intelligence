'use client'

/**
 * The page-wide pieces the agents' surfaces read, held once for the dashboard
 * (mounted beside the main chat in dashboard-shell.tsx). It draws nothing:
 *
 *   - who wears what, for the notices outside the shell's shared source (a
 *     banner's thread and title, a toast's signature): notice-faces.ts
 *     publishNoticeFaces, off the roster;
 *   - the voices the agents speak in (lib/bots/bot-voice.ts): the faces the
 *     reachable teammates wear, in crew order, with the voices their teammates
 *     chose, so no two faces share one while there are enough to go round
 *     (an agent's page reading replies aloud, the editor's Automatic);
 *   - the cards' picker lists (card-pickers.ts), loaded once for the page for
 *     the workspaces a card host names (the For you column, an agent's page),
 *     so a host mounting again fetches nothing it already has.
 */
import { useEffect, useMemo } from 'react'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { useRailPickerData } from '@/hooks/use-rail-picker-data'
import { chosenVoicesOf, useBotVoiceCrew } from '@/lib/bots/bot-voice'
import { publishCardPickers, useWantedCardWorkspaces } from '@/lib/bots/card-pickers'
import { publishNoticeFaces } from '@/lib/bots/notice-faces'
import { asBotCharacter, drawnBots, inCrewOrder, type FacedRosterEntry } from '@/lib/bots/teammate-faces'
import type { BotCharacterType } from '@/lib/bots/bot-faces'

/** The faces the roster's drawn teammates wear, each once, in crew order. */
export function rosterFaces(roster: readonly FacedRosterEntry[]): BotCharacterType[] {
  const worn = new Set<BotCharacterType>()
  for (const teammate of drawnBots(roster)) {
    const face = asBotCharacter(teammate.bot_character)
    if (face) worn.add(face)
  }
  return inCrewOrder(worn)
}

export function AgentInfraHost() {
  const { work } = useAgentWorkShared()
  useEffect(() => publishNoticeFaces(work.roster), [work.roster])

  const facesKey = useMemo(() => rosterFaces(work.roster).join(','), [work.roster])
  const faces = useMemo(() => (facesKey ? facesKey.split(',') : []), [facesKey])
  const chosenVoices = useMemo(() => chosenVoicesOf(work.roster), [work.roster])
  useBotVoiceCrew(faces, chosenVoices)

  const pickers = useRailPickerData(useWantedCardWorkspaces())
  useEffect(() => publishCardPickers(pickers.get), [pickers])
  useEffect(() => () => publishCardPickers(null), [])
  return null
}
