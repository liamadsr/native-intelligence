/**
 * Agent links in each owner's chat (chat-parts.ts, phase D): the parts are
 * data, so a malformed one draws nothing, and the lines name whose agent and
 * from where.
 */
import { describe, expect, it } from 'vitest'
import { agentLinkActivityMeta, agentLinkActivityPartData, agentLinkAskData, agentLinkLine, agentLinkRef } from '../chat-parts'
import { askCardPartData } from '@/lib/attention/chat-asks'

const LINK = '77777777-0000-4000-8000-000000000007'
const EXCHANGE = '88888888-0000-4000-8000-000000000008'
const CARD = '99999999-0000-4000-8000-000000000009'

describe('a link a part names', () => {
  it('needs a link id and a name; the workspace and exchange are optional', () => {
    expect(agentLinkRef({ link_id: LINK, peer_name: '  Dana   Kim ', workspace_name: 'Northwind', exchange_id: EXCHANGE })).toEqual({
      link_id: LINK,
      peer_name: 'Dana Kim',
      workspace_name: 'Northwind',
      exchange_id: EXCHANGE,
    })
    expect(agentLinkRef({ link_id: LINK, peer_name: 'Dana' })).toEqual({ link_id: LINK, peer_name: 'Dana', workspace_name: null })
    expect(agentLinkRef({ link_id: 'nope', peer_name: 'Dana' })).toBeNull()
    expect(agentLinkRef({ link_id: LINK, peer_name: '  ' })).toBeNull()
    expect(agentLinkRef('x')).toBeNull()
  })

  it('reads a held call’s context.agentLink', () => {
    expect(agentLinkAskData({ linkId: LINK, peerName: 'Dana Kim', workspaceName: null })).toEqual({ link_id: LINK, peer_name: 'Dana Kim', workspace_name: null })
    expect(agentLinkAskData(undefined)).toBeNull()
  })

  it('says whose agent, and from where', () => {
    expect(agentLinkLine({ peer_name: 'Dana Kim', workspace_name: 'Northwind' })).toBe('Dana Kim’s agent · Northwind')
    expect(agentLinkLine({ peer_name: 'Marco', workspace_name: null })).toBe('Marco’s agent')
  })
})

describe('an exchange’s activity part', () => {
  const good = { link_id: LINK, peer: { name: 'Dana Kim', workspace_name: 'Northwind' }, exchange_id: EXCHANGE, summary: 'Told Ava you’re free Thu 2:00 and Fri 10:00', count: 4, last_at: '2026-10-25T13:15:00Z' }

  it('reads a good one, and its second line', () => {
    const data = agentLinkActivityPartData(good)!
    expect(data).toEqual(good)
    expect(agentLinkActivityMeta(data, '1:15 PM')).toBe('Dana Kim’s agent · Northwind · 4 messages · 1:15 PM')
    expect(agentLinkActivityMeta({ ...data, count: 1 }, '1:15 PM')).toBe('Dana Kim’s agent · Northwind · 1:15 PM')
  })

  it('a malformed one is nothing; a bad count is one', () => {
    expect(agentLinkActivityPartData({ ...good, exchange_id: undefined })).toBeNull()
    expect(agentLinkActivityPartData({ ...good, peer: {} })).toBeNull()
    expect(agentLinkActivityPartData({ ...good, summary: '' })).toBeNull()
    expect(agentLinkActivityPartData({ ...good, last_at: 'soon' })).toBeNull()
    expect(agentLinkActivityPartData({ ...good, count: -2 })!.count).toBe(1)
  })
})

describe('a held call from another person’s agent', () => {
  it('its ask part carries the link, checked', () => {
    expect(askCardPartData({ card_id: CARD, workspace_id: 'ws', agent_link: { link_id: LINK, peer_name: 'Dana Kim', workspace_name: 'Northwind' } })!.agent_link).toEqual({
      link_id: LINK,
      peer_name: 'Dana Kim',
      workspace_name: 'Northwind',
    })
    expect(askCardPartData({ card_id: CARD, workspace_id: 'ws', agent_link: { link_id: 'x' } })!.agent_link).toBeUndefined()
  })

})
