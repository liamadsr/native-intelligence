/**
 * One face for the agent (docs/plans/always-on-agent.md §2c, decision 11):
 * the agent's one look and name, the area faces never drawn, the collision
 * guard, and an area face's id resolving to its workspace's Assistant.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_FACE,
  AGENT_FACE_RESERVED_ERROR,
  agentFaceRefused,
  SELF_OWNER,
  teammateOwnerOf,
  agentFacedRoster,
  agentName,
  agentTeammateIdFor,
  areaFaceKeyOf,
  isAgentTeammate,
  isAreaFaceTeammate,
  withAgentFace,
  withoutAreaFaces,
} from '../agent-face'
import { SYSTEM_TEAMMATE_FACES, drawnBots } from '../teammate-faces'
import { unreadNoticesOf } from '../bot-notice'
import { withFailedNotices } from '../failed-notices'
import { parseFlowBotInput } from '@/lib/flows/flow-bot'

const assistant = { id: 'as-1', workspace_id: 'ws-1', is_system: true, system_key: 'assistant', bot_character: 'ghost', name: 'Assistant', reachable: true }
const mail = { id: 'mail-1', workspace_id: 'ws-1', is_system: true, system_key: 'mail', bot_character: 'mail', name: 'Mail', reachable: true }
const captures = { id: 'cap-1', workspace_id: 'ws-1', is_system: true, system_key: 'captures', bot_character: 'triage', name: 'Captures', reachable: true }
const writer = { id: 'writer', workspace_id: 'ws-1', is_system: false, system_key: null, bot_character: 'writer', name: 'Writer', reachable: true }
const squatter = { id: 'squat', workspace_id: 'ws-1', is_system: false, system_key: null, bot_character: 'chat', name: 'Old helper', reachable: true }
const assistant2 = { id: 'as-2', workspace_id: 'ws-2', is_system: true, system_key: 'assistant', bot_character: 'chat', name: 'Assistant', reachable: true }
const mail2 = { id: 'mail-2', workspace_id: 'ws-2', is_system: true, system_key: 'mail', bot_character: 'mail', name: 'Mail', reachable: true }

describe('the agent’s one look and name', () => {
  it('is the Assistant system teammate’s reserved face, `chat`', () => {
    expect(AGENT_FACE).toBe('chat')
    expect(SYSTEM_TEAMMATE_FACES.assistant).toBe(AGENT_FACE)
  })

  it('names it with the saved assistant name, else "Assistant"', () => {
    expect(agentName('Joseph')).toBe('Joseph')
    expect(agentName('  Ada ')).toBe('Ada')
    expect(agentName(null)).toBe('Assistant')
    expect(agentName('   ')).toBe('Assistant')
  })

  it('tells the agent and the area faces apart', () => {
    expect(isAgentTeammate(assistant)).toBe(true)
    expect(isAgentTeammate(mail)).toBe(false)
    expect(isAgentTeammate({ is_system: false, system_key: 'assistant' })).toBe(false)
    expect(isAreaFaceTeammate(mail)).toBe(true)
    expect(isAreaFaceTeammate(captures)).toBe(true)
    expect(isAreaFaceTeammate(assistant)).toBe(false)
    expect(isAreaFaceTeammate(writer)).toBe(false)
    expect(areaFaceKeyOf(captures)).toBe('captures')
    expect(areaFaceKeyOf(assistant)).toBeNull()
  })
})

describe('withAgentFace', () => {
  it('puts the one look (and the name, when given) on every Assistant, whatever its row wears', () => {
    expect(withAgentFace(assistant)).toEqual({ ...assistant, bot_character: 'chat' })
    expect(withAgentFace(assistant, 'Joseph')).toEqual({ ...assistant, bot_character: 'chat', name: 'Joseph' })
  })

  it('leaves an Assistant already wearing it, unnamed, as the same object', () => {
    expect(withAgentFace(assistant2)).toBe(assistant2)
  })

  it('leaves a teammate that already wears the agent’s face alone (the picker no longer offers it)', () => {
    expect(withAgentFace(squatter)).toBe(squatter)
  })

  it('leaves everyone else alone', () => {
    expect(withAgentFace(writer, 'Joseph')).toBe(writer)
    expect(withAgentFace(mail, 'Joseph')).toBe(mail)
  })
})

describe('the roster as drawn', () => {
  const roster = [assistant, mail, captures, writer, squatter, assistant2, mail2]

  it('agentFacedRoster keeps the area faces (ids still resolve) and is the same array when nothing changes', () => {
    const faced = agentFacedRoster(roster, 'Joseph')
    expect(faced.map((t) => t.id)).toEqual(roster.map((t) => t.id))
    expect(faced.find((t) => t.id === 'as-1')).toMatchObject({ bot_character: 'chat', name: 'Joseph' })
    const plain = [writer, assistant2]
    expect(agentFacedRoster(plain)).toBe(plain)
  })

  it('withoutAreaFaces and drawnBots leave every area face out', () => {
    expect(withoutAreaFaces(roster).map((t) => t.id)).toEqual(['as-1', 'writer', 'squat', 'as-2'])
    expect(drawnBots(roster).map((t) => t.id)).toEqual(['as-1', 'writer', 'squat', 'as-2'])
  })

  it('an area face whose workspace’s Assistant isn’t in the roster stays drawn (its work stays with it)', () => {
    expect(withoutAreaFaces([mail2, writer]).map((t) => t.id)).toEqual(['mail-2', 'writer'])
    expect(drawnBots([assistant, mail, mail2]).map((t) => t.id)).toEqual(['as-1', 'mail-2'])
  })

  it('drawnBots draws every Assistant in the one look', () => {
    const drawn = drawnBots(roster)
    expect(drawn.find((t) => t.id === 'as-1')?.bot_character).toBe('chat')
    expect(drawn.find((t) => t.id === 'as-2')?.bot_character).toBe('chat')
  })
})

describe('agentTeammateIdFor', () => {
  const roster = [assistant, mail, writer, assistant2, mail2]

  it('an area face opens its own workspace’s Assistant', () => {
    expect(agentTeammateIdFor(roster, 'mail-1')).toBe('as-1')
    expect(agentTeammateIdFor(roster, 'mail-2')).toBe('as-2')
  })

  it('anyone else is itself, and so is an area face whose Assistant isn’t held', () => {
    expect(agentTeammateIdFor(roster, 'writer')).toBe('writer')
    expect(agentTeammateIdFor(roster, 'as-1')).toBe('as-1')
    expect(agentTeammateIdFor(roster, 'unknown')).toBe('unknown')
    expect(agentTeammateIdFor([mail], 'mail-1')).toBe('mail-1')
  })
})

describe('teammateOwnerOf: whose bot a notice’s teammate is (one face)', () => {
  const roster = [assistant, mail, captures, writer, mail2]

  it('an area face stands for its workspace’s Assistant; anyone else, and an area face with no Assistant held, for itself', () => {
    const ownerOf = teammateOwnerOf(roster)
    expect(ownerOf('mail-1')).toBe('as-1')
    expect(ownerOf('cap-1')).toBe('as-1')
    expect(ownerOf('writer')).toBe('writer')
    expect(ownerOf('as-1')).toBe('as-1')
    expect(ownerOf('mail-2')).toBe('mail-2')
    expect(ownerOf('unknown')).toBe('unknown')
    expect(teammateOwnerOf([writer])).toBe(SELF_OWNER)
  })

  it('the client’s notice filters read through it: the bubble’s unread list and the failed-run dot', () => {
    const ownerOf = teammateOwnerOf(roster)
    const notice = (id: string, teammate: string, over: Record<string, unknown> = {}) => ({
      id,
      type: 'work_failed',
      title: 'Mail',
      body: null,
      is_read: false,
      is_archived: false,
      metadata: { teammate_id: teammate, sentence: 'I couldn’t finish.', work_item_id: `wi-${id}` },
      ...over,
    })
    const held = [notice('n1', 'mail-1'), notice('n2', 'as-1'), notice('n3', 'writer'), notice('n4', 'cap-1', { is_read: true })]
    expect(unreadNoticesOf(held, 'as-1', new Set(), ownerOf).map((n) => n.id)).toEqual(['n1', 'n2'])
    // Without the mapping (the default): the exact teammate only.
    expect(unreadNoticesOf(held, 'as-1', new Set()).map((n) => n.id)).toEqual(['n2'])
    const counts = withFailedNotices(new Map(), held, ownerOf)
    expect(counts.get('tm:as-1')?.beckoning).toHaveLength(2)
    expect(counts.has('tm:mail-1')).toBe(false)
    expect(counts.get('tm:writer')?.beckoning).toHaveLength(1)
  })
})

describe('the server-side face reservation (one face)', () => {
  it('refuses the agent’s face on anyone but a workspace’s Assistant, and nothing else', () => {
    expect(agentFaceRefused('chat')).toBe(true)
    expect(agentFaceRefused('chat', null)).toBe(true)
    expect(agentFaceRefused('chat', { is_system: false, system_key: null })).toBe(true)
    expect(agentFaceRefused('chat', { is_system: true, system_key: 'mail' })).toBe(true)
    expect(agentFaceRefused('chat', { is_system: true, system_key: 'assistant' })).toBe(false)
    expect(agentFaceRefused('writer')).toBe(false)
    expect(agentFaceRefused(undefined)).toBe(false)
  })

  it('a loop’s bot can’t be picked by the agent’s face (the flow tools and routes share this parse)', () => {
    const refused = parseFlowBotInput({ bot_character: 'chat' })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(AGENT_FACE_RESERVED_ERROR)
    expect(parseFlowBotInput({ bot_character: 'writer' })).toMatchObject({ kind: 'character', character: 'writer' })
  })
})
