/**
 * The one agent editor's save (bots-v4 B1): the agent first, then this bot,
 * each through the route that checks its own rule, only what changed and only
 * what the caller may change. A step that fails stops the rest. "Make a copy
 * for this bot" copies the agent, then points this bot at it. A bot's voice
 * (B2) is its own: it goes with this bot's step only, never the agent's.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  botFieldsOf,
  editorRules,
  makeCopyForBot,
  otherBotsPhrase,
  planEditorSave,
  runEditorSave,
  saveFailureMessage,
  type AgentEditorData,
  type AgentFields,
  type BotFields,
  type EditorBot,
} from '../editor-model'

const agentFields: AgentFields = {
  name: 'Researcher',
  visibility: 'workspace',
  description: 'Finds things out',
  system_prompt: 'You research.',
  agent_config: { enabled_tools: ['search'], disabled_tools: [] },
}

function bot(over: Partial<EditorBot> = {}): EditorBot {
  return {
    id: 'bot-1',
    name: 'Riley',
    team_id: 'team-1',
    team_name: 'Sales',
    bot_character: 'scout',
    is_system: false,
    system_key: null,
    fronts_only: false,
    role: null,
    autonomy: 'propose',
    allowed_side_effects: ['read'],
    skill_ids: ['s1'],
    kind: 'agent_teammate',
    about: null,
    ...over,
  }
}

function data(over: Partial<AgentEditorData> = {}): AgentEditorData {
  return {
    agent: {
      id: 'agent-1',
      name: 'Researcher',
      description: 'Finds things out',
      system_prompt: 'You research.',
      agent_config: null,
      visibility: 'workspace',
      is_system: false,
      created_by: 'u-author',
      icon: null,
      color: null,
      kind: 'workspace',
    },
    bots: [bot()],
    hidden_bots: 0,
    focus: 'bot-1',
    caller: { user_id: 'u-owner', role: 'owner', lead_team_ids: [] },
    teams: [],
    workspace_faces: [],
    ...over,
  }
}

const botBefore: BotFields = { name: 'Riley', bot_character: 'scout', team_id: 'team-1', bounds: 'read' }

function plan(over: Partial<Parameters<typeof planEditorSave>[0]> & { data?: AgentEditorData } = {}) {
  const d = over.data ?? data()
  const b = over.bot === undefined ? d.bots[0] : over.bot
  return planEditorSave({
    agentId: d.agent?.id ?? null,
    bot: b,
    rules: over.rules ?? editorRules(d, b),
    agentBefore: agentFields,
    agentAfter: agentFields,
    skillsBefore: ['s1'],
    skillsAfter: ['s1'],
    botBefore,
    botAfter: botBefore,
    ...over,
  })
}

describe('planEditorSave', () => {
  it('nothing changed, nothing sent', () => {
    expect(plan()).toEqual([])
  })

  it('writes the agent first, then its skills, then this bot, then its bounds', () => {
    const steps = plan({
      agentAfter: { ...agentFields, system_prompt: 'You research, carefully.' },
      skillsAfter: ['s2', 's1'],
      botAfter: { ...botBefore, name: 'Rae', bot_character: 'ember', bounds: 'internal' },
    })
    expect(steps.map((s) => s.key)).toEqual(['agent', 'agent_skills', 'bot', 'bounds'])
    expect(steps[0]).toMatchObject({ method: 'PATCH', url: '/api/account/agents/agent-1', body: { system_prompt: 'You research, carefully.' } })
    expect(steps[1]).toMatchObject({ method: 'PUT', url: '/api/account/agents/agent-1/skills', body: { skill_recipe_ids: ['s2', 's1'] } })
    expect(steps[2]).toMatchObject({ method: 'PATCH', url: '/api/account/teams/team-1/ai-members/bot-1', body: { name: 'Rae', bot_character: 'ember' } })
    expect(steps[3]).toMatchObject({
      method: 'PATCH',
      url: '/api/account/workspace/agent-autonomy/teammates/bot-1',
      body: { allowed_side_effects: ['read', 'internal-write'] },
    })
  })

  it('sends only what changed, and a cleared description as empty', () => {
    const steps = plan({ agentAfter: { ...agentFields, description: undefined } })
    expect(steps).toHaveLength(1)
    expect(steps[0].body).toEqual({ description: '' })
  })

  it('moves a full teammate to another team through its current team’s route', () => {
    const [step] = plan({ botAfter: { ...botBefore, team_id: 'team-2' } })
    expect(step).toMatchObject({ url: '/api/account/teams/team-1/ai-members/bot-1', body: { team_id: 'team-2' } })
  })

  it('saves a work bot through the work-bot route, and never its team or bounds', () => {
    const workBot = bot({ kind: 'agent_work_bot', fronts_only: true })
    // Its agent's author: a work bot that fronts an agent is theirs to change.
    const d = data({ bots: [workBot], caller: { user_id: 'u-author', role: 'member', lead_team_ids: [] } })
    const steps = plan({ data: d, bot: workBot, botAfter: { name: 'Coach', bot_character: 'ember', team_id: 'team-2', bounds: 'internal' } })
    expect(steps).toEqual([
      { key: 'bot', label: 'this agent', method: 'PATCH', url: '/api/account/work-bots/bot-1', body: { name: 'Coach', bot_character: 'ember' } },
    ])
  })

  it('never sends a field the caller may not change: a team lead’s agent edit and bounds', () => {
    const d = data({ caller: { user_id: 'u-lead', role: 'member', lead_team_ids: ['team-1'] } })
    const steps = plan({
      data: d,
      agentAfter: { ...agentFields, name: 'Hijacked' },
      skillsAfter: ['s9'],
      botAfter: { ...botBefore, name: 'Rae', bounds: 'internal' },
    })
    // The lead manages the bot's team, so its name saves; the agent and the bounds don't.
    expect(steps.map((s) => s.key)).toEqual(['bot'])
    expect(steps[0].body).toEqual({ name: 'Rae' })
  })

  it('a system teammate’s skills go with it, through its own route; it has no agent step', () => {
    const triage = bot({ id: 'triage', kind: 'system_teammate', is_system: true, system_key: 'triage', team_id: 'team-g' })
    const d = data({ agent: null, bots: [triage], focus: 'triage' })
    const steps = planEditorSave({
      agentId: null,
      bot: triage,
      rules: editorRules(d, triage),
      agentBefore: null,
      agentAfter: null,
      skillsBefore: [],
      skillsAfter: ['s1'],
      botBefore: { ...botBefore, team_id: 'team-g' },
      botAfter: { ...botBefore, team_id: 'team-g', name: 'Sorter' },
    })
    expect(steps).toEqual([
      { key: 'bot', label: 'this agent', method: 'PATCH', url: '/api/account/teams/team-g/ai-members/triage', body: { name: 'Sorter', skill_recipe_ids: ['s1'] } },
    ])
  })

  it('gives an agent with no bot its bot after its own fields and before its skills', () => {
    const d = data({ bots: [], focus: null, caller: { user_id: 'u-author', role: 'member', lead_team_ids: [] } })
    const steps = planEditorSave({
      agentId: 'agent-1',
      bot: null,
      rules: editorRules(d, null),
      agentBefore: { ...agentFields, visibility: 'personal' },
      agentAfter: agentFields,
      skillsBefore: [],
      skillsAfter: ['s1'],
      botBefore: null,
      botAfter: null,
      newBotFace: 'ember',
    })
    expect(steps.map((s) => s.key)).toEqual(['agent', 'new_bot', 'agent_skills'])
    expect(steps[0].body).toEqual({ visibility: 'workspace' })
    expect(steps[1]).toMatchObject({ method: 'POST', url: '/api/account/agents/agent-1/bot', body: { bot_character: 'ember' } })
  })
})

describe('planEditorSave — its voice (Phase B2, decision 11)', () => {
  it('reads a bot’s voice into its fields, Automatic when it has none', () => {
    expect(botFieldsOf(bot({ voice: 'lori' })).voice).toBe('lori')
    expect(botFieldsOf(bot({ voice: null })).voice).toBeNull()
    expect(botFieldsOf(bot()).voice).toBeNull()
  })

  it('sends a new voice with this bot’s own step, and never with the agent’s', () => {
    const steps = plan({
      agentAfter: { ...agentFields, system_prompt: 'You research, carefully.' },
      botAfter: { ...botBefore, voice: 'lori' },
    })
    expect(steps.map((s) => s.key)).toEqual(['agent', 'bot'])
    expect(steps[0].body).toEqual({ system_prompt: 'You research, carefully.' })
    expect(steps[1]).toMatchObject({ method: 'PATCH', url: '/api/account/teams/team-1/ai-members/bot-1', body: { voice: 'lori' } })
  })

  it('back to Automatic is a change too: null', () => {
    const [step] = plan({ botBefore: { ...botBefore, voice: 'lori' }, botAfter: { ...botBefore, voice: null } })
    expect(step).toMatchObject({ key: 'bot', body: { voice: null } })
  })

  it('an unchanged voice, Automatic or not, sends nothing', () => {
    expect(plan({ botBefore: { ...botBefore, voice: 'lori' }, botAfter: { ...botBefore, voice: 'lori' } })).toEqual([])
    // Absent and null are both Automatic.
    expect(plan({ botBefore: { ...botBefore, voice: null }, botAfter: botBefore })).toEqual([])
  })

  it('a work bot’s goes through the work-bot route; a system teammate’s through its own', () => {
    const workBot = bot({ kind: 'agent_work_bot', fronts_only: true })
    const d = data({ bots: [workBot], caller: { user_id: 'u-author', role: 'member', lead_team_ids: [] } })
    expect(plan({ data: d, bot: workBot, botAfter: { ...botBefore, voice: 'aba' } })).toEqual([
      { key: 'bot', label: 'this agent', method: 'PATCH', url: '/api/account/work-bots/bot-1', body: { voice: 'aba' } },
    ])
    const triage = bot({ id: 'triage', kind: 'system_teammate', is_system: true, system_key: 'triage', team_id: 'team-g' })
    const t = data({ agent: null, bots: [triage], focus: 'triage', caller: { user_id: 'u-lead', role: 'member', lead_team_ids: ['team-g'] } })
    expect(plan({ data: t, bot: triage, agentId: null, agentBefore: null, agentAfter: null, botAfter: { ...botBefore, voice: 'aba' } })).toEqual([
      { key: 'bot', label: 'this agent', method: 'PATCH', url: '/api/account/teams/team-g/ai-members/triage', body: { voice: 'aba' } },
    ])
  })

  it('never sends a voice the caller may not change', () => {
    const d = data({ caller: { user_id: 'u-member', role: 'member', lead_team_ids: [] } })
    expect(plan({ data: d, botAfter: { ...botBefore, voice: 'lori' } })).toEqual([])
  })

  it('a bot given to an agent starts in the voice picked, or on Automatic', () => {
    const d = data({ bots: [], focus: null, caller: { user_id: 'u-author', role: 'member', lead_team_ids: [] } })
    const give = (newBotVoice: string | null) =>
      planEditorSave({
        agentId: 'agent-1',
        bot: null,
        rules: editorRules(d, null),
        agentBefore: agentFields,
        agentAfter: agentFields,
        skillsBefore: [],
        skillsAfter: [],
        botBefore: null,
        botAfter: null,
        newBotFace: 'ember',
        newBotVoice,
      })
    expect(give('cha')).toEqual([
      { key: 'new_bot', label: 'its agent', method: 'POST', url: '/api/account/agents/agent-1/bot', body: { bot_character: 'ember', voice: 'cha' } },
    ])
    expect(give(null)[0].body).toEqual({ bot_character: 'ember' })
  })
})

describe('runEditorSave', () => {
  const steps = plan({
    agentAfter: { ...agentFields, name: 'Scout' },
    botAfter: { ...botBefore, name: 'Rae' },
  })

  it('runs every step in order', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    const out = await runEditorSave(steps, { fetcher: fetcher as unknown as typeof fetch, workspaceId: 'ws-2' })
    expect(out).toEqual({ ok: true, saved: ['the persona', 'this agent'], warnings: [] })
    expect(fetcher.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      '/api/account/agents/agent-1',
      '/api/account/teams/team-1/ai-members/bot-1',
    ])
    // The bot's own workspace rides every request.
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'x-workspace-id': 'ws-2' })
  })

  it('stops at the first refusal and says what saved and what didn’t', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Only workspace admins and this team’s leads can edit its AI teammates' }), { status: 403 }))
    const out = await runEditorSave(steps, { fetcher: fetcher as unknown as typeof fetch })
    expect(out).toEqual({
      ok: false,
      saved: ['the persona'],
      notSaved: ['this agent'],
      error: 'Only workspace admins and this team’s leads can edit its AI teammates',
      warnings: [],
    })
    expect(saveFailureMessage(out as Extract<typeof out, { ok: false }>)).toBe(
      'Saved the persona. Didn’t save this agent: Only workspace admins and this team’s leads can edit its AI teammates',
    )
  })

  it('a refused first step saves nothing', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }))
    const out = await runEditorSave(steps, { fetcher: fetcher as unknown as typeof fetch })
    expect(out).toMatchObject({ ok: false, saved: [], notSaved: ['the persona', 'this agent'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('says when a new bot was made without its agent’s skills, unless the save sets them next', async () => {
    const newBot = { key: 'new_bot' as const, label: 'its agent', method: 'POST' as const, url: '/api/account/agents/agent-1/bot', body: {} }
    const skillsStep = { key: 'agent_skills' as const, label: 'its skills', method: 'PUT' as const, url: '/api/account/agents/agent-1/skills', body: { skill_recipe_ids: [] } }
    const made = () => new Response(JSON.stringify({ ai_team_member: { id: 'bot-9' }, skills_error: 'It didn’t get the skills.' }), { status: 201 })
    let fetcher = vi.fn(async () => made())
    expect(await runEditorSave([newBot], { fetcher: fetcher as unknown as typeof fetch })).toEqual({
      ok: true,
      saved: ['its agent'],
      warnings: ['It didn’t get the skills.'],
    })
    fetcher = vi.fn().mockResolvedValueOnce(made()).mockResolvedValueOnce(new Response('{}', { status: 200 }))
    expect((await runEditorSave([newBot, skillsStep], { fetcher: fetcher as unknown as typeof fetch })).warnings).toEqual([])
  })
})

describe('makeCopyForBot', () => {
  it('copies the agent, then points a full teammate at the copy through its team’s route', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agent: { id: 'copy-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const out = await makeCopyForBot({ agentId: 'agent-1', bot: bot(), name: 'Researcher for Riley', fetcher: fetcher as unknown as typeof fetch })
    expect(out).toEqual({ ok: true, agentId: 'copy-1' })
    const [copyCall, repointCall] = fetcher.mock.calls as unknown as Array<[string, RequestInit]>
    expect(copyCall[0]).toBe('/api/account/agents/agent-1/copy')
    expect(JSON.parse(copyCall[1].body as string)).toEqual({ name: 'Researcher for Riley' })
    expect(repointCall[0]).toBe('/api/account/teams/team-1/ai-members/bot-1')
    expect(JSON.parse(repointCall[1].body as string)).toEqual({ agent_recipe_id: 'copy-1' })
  })

  it('points a work bot through the work-bot route', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agent: { id: 'copy-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await makeCopyForBot({ agentId: 'agent-1', bot: bot({ kind: 'agent_work_bot' }), name: 'x', fetcher: fetcher as unknown as typeof fetch })
    expect((fetcher.mock.calls[1] as unknown as [string])[0]).toBe('/api/account/work-bots/bot-1')
  })

  it('deletes the copy again when the bot can’t be pointed at it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agent: { id: 'copy-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Only workspace admins and this team’s leads can edit its AI teammates' }), { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const out = await makeCopyForBot({ agentId: 'agent-1', bot: bot(), name: 'x', fetcher: fetcher as unknown as typeof fetch })
    expect(out).toEqual({ ok: false, error: 'Only workspace admins and this team’s leads can edit its AI teammates' })
    const third = fetcher.mock.calls[2] as unknown as [string, RequestInit]
    expect(third[0]).toBe('/api/account/agents/copy-1')
    expect(third[1].method).toBe('DELETE')
  })
})

describe('naming the other bots a save changes', () => {
  it('names the bots by team, then counts the ones on private teams', () => {
    expect(otherBotsPhrase([{ name: 'Riley', team_name: 'Sales' }], 0)).toBe('Riley in Sales')
    expect(otherBotsPhrase([{ name: 'Riley', team_name: 'Sales' }, { name: 'Writer', team_name: null }], 1)).toBe(
      'Riley in Sales, Writer and 1 on a private team',
    )
    expect(otherBotsPhrase([], 2)).toBe('2 on private teams')
  })
})
