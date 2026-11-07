/**
 * A guest's agent's spec: none of the owner's layers, only "## Who you are"
 * (the owner's agent for this one person), the owner's notes and what was
 * learned about the guest; the tools the owner gave them, all up front; no
 * skills; the channel turn's Fast model, billed to the owner. A guest who is
 * gone refuses the turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGuest } from '../store'

const h = vi.hoisted(() => ({
  guest: null as unknown,
  memory: [] as Array<{ kind: 'fact' | 'preference'; text: string }>,
  usage: {} as unknown,
  outcomes: [] as Array<{ key: string; markdown: string }>,
  outcomesFor: [] as unknown[],
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('../guest-turn', async (orig) => ({
  ...(await orig<typeof import('../guest-turn')>()),
  loadGuestTurn: vi.fn(async () => h.guest),
  ownerDisplayName: vi.fn(async () => 'Liam'),
  readGuestMemory: vi.fn(async () => h.memory),
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => h.usage) }))
vi.mock('../guest-approvals', () => ({
  buildGuestApprovalSections: vi.fn(async (_db: unknown, scope: unknown) => (h.outcomesFor.push(scope), h.outcomes)),
}))
vi.mock('@/lib/agent-events/member-time-zone', () => ({ readMemberTimeZone: vi.fn(async () => ({ timeZone: 'America/Los_Angeles', source: 'member' })) }))

import { GuestTurnRefused, buildGuestWhoYouAre, guestInvitationLine, guestReachLines, guestWaitsLine, rebuildGuestChatSpec } from '../guest-spec'
import { GUEST_TOOL_GROUPS, presetSettings } from '../presets'
import { guestCeiling } from '../guest-turn'

const CLAIMS = { conversationId: 'conv-g', userId: 'owner-1', workspaceId: 'ws-1', server: 'channel_turn', surface: 'sms', guestId: 'g1', exp: Date.now() + 60_000 } as never

function guest(over: Partial<AgentGuest> = {}): AgentGuest {
  return {
    id: 'g1',
    ownerUserId: 'owner-1',
    workspaceId: 'ws-1',
    displayName: 'Sam',
    phone: '+15551234567',
    channels: ['sms'],
    phoneBoundAt: null,
    slackTeamId: null,
    slackUserId: null,
    peerUserId: null,
    peerBoundAt: null,
    calendarEmails: [],
    businessNumberId: null,
    contactId: null,
    preset: 'household',
    tools: ['get_free_busy', 'get_calendar_events', 'create_calendar_event', 'web_search', 'web_fetch', 'message_owner', 'ask_owner_agent', 'remember_about_guest'],
    askTools: ['create_calendar_event'],
    askBefore: ['payments', 'deletes'],
    notes: 'My wife. Book the usual place for date night.',
    state: 'active',
    inviteExpiresAt: null,
    requestedAt: null,
    activatedAt: null,
    removedAt: null,
    optedOut: false,
    lastInboundAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  h.guest = guest()
  h.memory = []
  h.usage = {}
  h.outcomes = []
  h.outcomesFor = []
})

describe('rebuildGuestChatSpec', () => {
  it('refuses a guest who is gone', async () => {
    h.guest = null
    await expect(rebuildGuestChatSpec(CLAIMS)).rejects.toBeInstanceOf(GuestTurnRefused)
  })

  it('the ceiling is what the owner gave them, minus the agent’s own web tools, with the tools to reach the owner, all up front', async () => {
    const spec = await rebuildGuestChatSpec(CLAIMS, { includeSchemas: true })
    expect(spec.ceiling).toEqual(['get_free_busy', 'get_calendar_events', 'create_calendar_event', 'message_owner', 'ask_owner_agent', 'remember_about_guest'])
    expect(spec.coreToolNames).toEqual(spec.ceiling)
    expect(spec.ceilingTools.map((t) => t.name)).toEqual(spec.ceiling)
    expect(spec.ceilingTools.every((t) => t.inputSchema && t.description)).toBe(true)
    expect(spec.skills).toEqual([])
    expect(spec.packs).toBeUndefined()
  })

  it('speaks as the owner’s agent for this person, with the owner’s notes, and none of the owner’s own layers', async () => {
    h.memory = [{ kind: 'preference', text: 'Texts are best after 6pm' }]
    const spec = await rebuildGuestChatSpec(CLAIMS, { splitTurnContext: true })
    expect(spec.systemPrompt).toContain("## Who you are\nYou are Liam's agent for Sam.")
    expect(spec.systemPrompt).toContain('Book the usual place for date night.')
    expect(spec.systemPrompt).toContain('Prefers: Texts are best after 6pm')
    expect(spec.systemPrompt).toContain('never from Liam')
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'channel'])
    expect(spec.turnContext?.[0].markdown).toContain('America/Los_Angeles')
    for (const layer of ['Available skills', 'Connected external MCP servers', 'workspace brief']) expect(spec.systemPrompt).not.toContain(layer)
  })

  // PROD 11-02: Liam approved Jess's cards at 8:05; her agent never learned it.
  it('carries how each call it held for the owner ended, after the channel line; never for a customer', async () => {
    h.outcomes = [{ key: 'approval-bc0234ee23dd', markdown: '## Approved call finished: Update Event' }]
    const spec = await rebuildGuestChatSpec(CLAIMS, { splitTurnContext: true })
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'channel', 'approval-bc0234ee23dd'])
    expect(h.outcomesFor).toEqual([expect.objectContaining({ guestId: 'g1', userId: 'owner-1', workspaceId: 'ws-1', ownerName: 'Liam', guestName: 'Sam' })])
    h.outcomesFor = []
    h.guest = guest({ preset: 'customer' })
    await rebuildGuestChatSpec(CLAIMS, { splitTurnContext: true }).catch(() => null)
    expect(h.outcomesFor).toEqual([])
  })

  it('runs on the owner’s ChatGPT plan when that is how they run', async () => {
    const gateway = await rebuildGuestChatSpec(CLAIMS)
    expect(gateway.chatgptPlan).toBeUndefined()
    expect(gateway.modelRoute?.tier).toBe('fast')
    h.usage = { reason: 'chatgpt_plan' }
    const plan = await rebuildGuestChatSpec(CLAIMS)
    expect(plan.chatgptPlan).toBeDefined()
    expect(plan.model.startsWith('openai/')).toBe(true)
    expect(plan.gatewayTelemetry).toBeUndefined()
  })
})

describe('buildGuestWhoYouAre', () => {
  it('with no tools of the owner’s, says it can only chat and use the web', () => {
    const text = buildGuestWhoYouAre({ ownerName: 'Liam', guest: { displayName: 'Jason', notes: null }, toolNames: [], memory: [] })
    expect(text).toContain('gave you no tools of theirs')
    expect(text).not.toContain("Liam's notes")
  })
})

describe('the guest’s agent knows what its tools reach (PROD 10-27: it said it couldn’t see the calendar it could)', () => {
  const ceilingOf = (preset: 'household' | 'colleague') => [...guestCeiling({ tools: presetSettings(preset).tools, preset })]
  const prompt = (ownerName: string, preset: 'household' | 'colleague') =>
    buildGuestWhoYouAre({ ownerName, guest: { displayName: 'Sam', notes: null }, toolNames: ceilingOf(preset), memory: [] })

  it('Household: each group it holds, in words written for the agent, and to look things up before saying it can’t', () => {
    const text = prompt('Liam', 'household')
    expect(text).toContain('- See whether Liam is free or busy at a time: busy times only, never what an event is (get_free_busy)')
    expect(text).toContain('- See Liam’s calendar events, with their titles, places and people (get_calendar_events, get_upcoming_meetings)')
    expect(text).toContain('- Look up the people Liam knows (list_contacts, get_contact)')
    expect(text).toContain("Look things up with them before you answer. Never tell Sam you can't see or do something one of them reaches.")
    // The web tools are the agent's own: the ceiling never carries them, so no line for them.
    expect(text).not.toContain('Search and read the web')
  })

  it('Colleague: free/busy and proposing events, never anything that reads what an event is', () => {
    const text = prompt('Liam', 'colleague')
    expect(text).toContain('(get_free_busy)')
    expect(text).toContain('- Propose an event on Liam’s calendar (create_calendar_event)')
    expect(text).not.toMatch(/titles|places and people|calendar events|Liam’s tasks|people Liam knows|email drafts/i)
  })

  it('names the owner it is given, never another', () => {
    const text = prompt('Marco', 'household')
    expect(text).toContain("that's Marco's call")
    expect(text).not.toContain('Liam')
  })

  it('a group held only in part names just the tools held', () => {
    expect(guestReachLines('Liam', ['list_actions', 'get_action'])).toEqual(['- List Actions, Get Action (list_actions, get_action)'])
    expect(guestReachLines('Liam', ['ask_owner_agent', 'message_owner', 'remember_about_guest'])).toEqual([])
  })

  it('every group has a line for the agent, with the owner’s name and nothing addressed to the owner', () => {
    for (const g of GUEST_TOOL_GROUPS) {
      const [line] = guestReachLines('Marco', g.tools)
      expect(line, g.id).toBeTruthy()
      expect(line, g.id).not.toMatch(/\byou(r|’re|'re)?\b(?! own browser)/)
      expect(line, g.id).not.toContain('{owner}')
    }
  })

  it('an invitation: saying yes is the owner’s; free times only as the owner’s free/busy setting lets them out', () => {
    const household = guestInvitationLine('Liam', 'Sam', ['get_free_busy', 'get_calendar_events', 'create_calendar_event'])
    expect(household).toContain("never tell Sam that Liam will come, or that it's set, before Liam says yes")
    expect(household).toContain('You may tell Sam whether Liam is free then, as your tools show it, and that Liam will confirm.')
    expect(household).toContain('asks to be checked with first, share no times')
    expect(household).toContain('propose it with create_calendar_event')
    // No free/busy and no calendar: nothing to share, only ask.
    const blind = guestInvitationLine('Liam', 'Sam', ['create_action'])
    expect(blind).not.toContain('whether Liam is free')
    expect(blind).not.toContain('create_calendar_event')
    expect(blind).toContain("Ask Liam's own agent with ask_owner_agent, and tell Sam you've asked.")
  })
})

describe('what waits for the owner, per person', () => {
  it('deletes and payments ask by default, and the line follows what the owner turned off', () => {
    const all = guestWaitsLine('Liam', 'Sam')
    expect(all).toContain('deletes something')
    expect(all).toContain('stops before it pays')
    const noDeletes = guestWaitsLine('Liam', 'Sam', ['payments'])
    expect(noDeletes).not.toContain('deletes something')
    expect(noDeletes).toContain('stops before it pays')
    const neither = guestWaitsLine('Liam', 'Sam', [])
    expect(neither).toContain("Anything that sends something or changes something outside Dial8 waits for Liam's OK")
    expect(neither).not.toContain('pays')
  })

  // The owner decides each tool (2026-11-02): the agent is told exactly which wait, so it never promises a card for a call that just runs.
  it('with the owner’s per-tool settings, names exactly what waits', () => {
    expect(guestWaitsLine('Liam', 'Jess', ['payments'], ['delete_calendar_event'])).toMatch(/^These wait for Liam's OK in Dial8 and run once they approve it: .+\. The rest runs without waiting on Liam, unless a tool's answer says it is waiting\./)
    expect(guestWaitsLine('Liam', 'Jess', ['payments'], [])).toMatch(/^Your tools run without waiting on Liam, unless a tool's answer says it is waiting\./)
  })

  // PROD 11-02: the agent held the Tuesday run back "until he approves the others", and nothing ever raised it.
  it('says the guest hears how it ended, and to raise every call a request needs together', () => {
    const line = guestWaitsLine('Liam', 'Jess')
    expect(line).toContain("you read how it ended in your next turn: tell Jess then if they haven't heard it from you")
    expect(line).toContain('Raise every call the request needs together')
  })

  // PROD 11-02: "night-before reminders" were saved as a note and told to Jess as a standing rule.
  it('a note about the guest sets nothing up: later or scheduled work goes to the owner’s agent', () => {
    const text = buildGuestWhoYouAre({ ownerName: 'Liam', guest: { displayName: 'Jess', notes: null }, toolNames: [], memory: [] })
    expect(text).toContain('remember_about_guest only keeps a note for your own conversations with Jess')
    expect(text).toContain("For anything that must happen on Liam's side later or on a schedule (a reminder, a routine, a check-in), ask Liam's own agent with ask_owner_agent")
  })
})
