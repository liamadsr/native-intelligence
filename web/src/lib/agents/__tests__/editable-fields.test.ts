/**
 * The one agent editor's field rules (bots-v4 B1): what each kind of bot may
 * change at all, and who may change it. The editor draws from these and the
 * routes refuse by them, so the plan's field table is pinned here.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_FIELDS,
  BOUNDS_CLASSES,
  FIELD_REASONS,
  MAX_PINNED_SKILLS,
  botKindOf,
  boundsChoiceOf,
  copyNameFor,
  fieldRule,
  isPinnableSkill,
  kindAllows,
  mayRepointToCopy,
  parseBounds,
  personaKindOf,
  personaRule,
  skillsRouteFor,
  type BotKind,
  type EditorCaller,
  type EditorField,
  type PersonaFacts,
} from '../editable-fields'

const WS = 'ws-1'
const owner: EditorCaller = { userId: 'u-owner', role: 'owner' }
const lead: EditorCaller = { userId: 'u-lead', role: 'member', leadsBotTeam: true }
const member: EditorCaller = { userId: 'u-member', role: 'member' }
const author: EditorCaller = { userId: 'u-author', role: 'member' }
const custom: PersonaFacts = { kind: 'workspace', createdBy: 'u-author' }

const editable = (kind: BotKind, field: EditorField, caller: EditorCaller, persona: PersonaFacts = custom) =>
  fieldRule({ kind, field, persona, caller }).editable

describe('what kind of bot a teammate is', () => {
  it('reads the persona: a workspace agent, a built-in one, or an anchor', () => {
    expect(personaKindOf({ category: 'agent', workspace_id: WS, is_system: false }, WS)).toBe('workspace')
    expect(personaKindOf({ category: 'agent', workspace_id: null, is_system: true }, WS)).toBe('builtin')
    // The loop anchors: no workspace, not system (migrations 283, 302).
    expect(personaKindOf({ category: 'agent', workspace_id: null, is_system: false }, WS)).toBe('anchor')
    expect(personaKindOf({ category: 'agent', workspace_id: 'ws-2', is_system: false }, WS)).toBe('anchor')
    expect(personaKindOf({ category: 'skill', workspace_id: WS, is_system: false }, WS)).toBe('anchor')
    expect(personaKindOf(null, WS)).toBe('anchor')
  })

  it('tells the five kinds apart', () => {
    expect(botKindOf({ is_system: true }, 'anchor')).toBe('system_teammate')
    expect(botKindOf({ fronts_only: true }, 'anchor')).toBe('loop_work_bot')
    expect(botKindOf({ fronts_only: true }, 'workspace')).toBe('agent_work_bot')
    expect(botKindOf({ role: 'writer' }, 'workspace')).toBe('role_teammate')
    expect(botKindOf({ role: null }, 'workspace')).toBe('agent_teammate')
    expect(botKindOf({ role: 'not-a-role' }, 'builtin')).toBe('agent_teammate')
  })
})

describe('the field table, per kind (whoever asks)', () => {
  it('a custom agent’s full teammate and a role teammate change everything, its voice included (Phase B2)', () => {
    for (const kind of ['agent_teammate', 'role_teammate'] as BotKind[]) {
      for (const field of [...AGENT_FIELDS, 'name', 'face', 'voice', 'team', 'bounds'] as EditorField[]) {
        expect(kindAllows(kind, field).editable, `${kind} ${field}`).toBe(true)
      }
    }
  })

  it('every kind of bot has a voice of its own to change (the plan’s table: Voice, yes for all)', () => {
    for (const kind of ['agent_teammate', 'role_teammate', 'agent_work_bot', 'system_teammate', 'loop_work_bot'] as BotKind[]) {
      expect(kindAllows(kind, 'voice'), kind).toEqual({ editable: true })
    }
  })

  it('a custom agent’s work bot: the agent, its name, face and voice; it stays on its team and keeps read and propose', () => {
    for (const field of [...AGENT_FIELDS, 'name', 'face', 'voice'] as EditorField[]) {
      expect(kindAllows('agent_work_bot', field).editable, field).toBe(true)
    }
    expect(kindAllows('agent_work_bot', 'team')).toEqual({ editable: false, reason: FIELD_REASONS.workBotTeam })
    expect(kindAllows('agent_work_bot', 'bounds')).toEqual({ editable: false, reason: FIELD_REASONS.workBotBounds })
  })

  it('a system teammate: its name, face, voice and skills, nothing it speaks from', () => {
    expect(kindAllows('system_teammate', 'name').editable).toBe(true)
    expect(kindAllows('system_teammate', 'face').editable).toBe(true)
    expect(kindAllows('system_teammate', 'voice').editable).toBe(true)
    expect(kindAllows('system_teammate', 'skills').editable).toBe(true)
    for (const field of ['agent_name', 'sharing', 'description', 'instructions', 'tools'] as EditorField[]) {
      expect(kindAllows('system_teammate', field)).toEqual({ editable: false, reason: FIELD_REASONS.systemSpeaks })
    }
    expect(kindAllows('system_teammate', 'team')).toEqual({ editable: false, reason: FIELD_REASONS.systemTeam })
    expect(kindAllows('system_teammate', 'bounds')).toEqual({ editable: false, reason: FIELD_REASONS.systemBounds })
  })

  it('a loop’s work bot: only its name, face and voice', () => {
    expect(kindAllows('loop_work_bot', 'name').editable).toBe(true)
    expect(kindAllows('loop_work_bot', 'face').editable).toBe(true)
    expect(kindAllows('loop_work_bot', 'voice').editable).toBe(true)
    for (const field of ['agent_name', 'sharing', 'description', 'instructions', 'tools', 'skills', 'team', 'bounds'] as EditorField[]) {
      expect(kindAllows('loop_work_bot', field).editable, field).toBe(false)
    }
    expect(kindAllows('loop_work_bot', 'skills')).toEqual({ editable: false, reason: FIELD_REASONS.loopSkills })
  })
})

describe('who may change a field', () => {
  it('the agent’s fields, skills included, follow the recipe’s rule: its author, or an owner or admin', () => {
    for (const field of AGENT_FIELDS) {
      expect(editable('agent_teammate', field, author), field).toBe(true)
      expect(editable('agent_teammate', field, owner), field).toBe(true)
      expect(editable('agent_teammate', field, { userId: 'u-admin', role: 'admin' }), field).toBe(true)
      // A team lead who isn't the author can't: the agent is shared by bots on other teams.
      expect(fieldRule({ kind: 'agent_teammate', field, persona: custom, caller: lead })).toEqual({
        editable: false,
        reason: FIELD_REASONS.agentAuthorOnly,
      })
    }
  })

  it('a built-in agent is nobody’s to change: make a copy first', () => {
    expect(fieldRule({ kind: 'agent_teammate', field: 'instructions', persona: { kind: 'builtin' }, caller: owner })).toEqual({
      editable: false,
      reason: FIELD_REASONS.builtinAgent,
    })
    expect(personaRule({ kind: 'builtin' }, owner).editable).toBe(false)
    expect(personaRule({ kind: 'anchor' }, owner).editable).toBe(false)
  })

  it('a full teammate’s own fields are for owners, admins and its team’s leads', () => {
    for (const field of ['name', 'face', 'team'] as EditorField[]) {
      expect(editable('agent_teammate', field, owner), field).toBe(true)
      expect(editable('agent_teammate', field, lead), field).toBe(true)
      expect(fieldRule({ kind: 'role_teammate', field, persona: custom, caller: member })).toEqual({
        editable: false,
        reason: FIELD_REASONS.botManagersOnly,
      })
    }
  })

  it('a work bot’s, for whoever may edit what it fronts: any member for a loop’s bot, the agent’s rule for an agent’s', () => {
    const anchor: PersonaFacts = { kind: 'anchor' }
    expect(editable('loop_work_bot', 'face', member, anchor)).toBe(true)
    expect(editable('loop_work_bot', 'name', member, anchor)).toBe(true)
    // A plain member's agent's bot: its author, or an owner or admin; never another member.
    expect(editable('agent_work_bot', 'name', author)).toBe(true)
    expect(editable('agent_work_bot', 'face', owner)).toBe(true)
    expect(fieldRule({ kind: 'agent_work_bot', field: 'name', persona: custom, caller: member })).toEqual({
      editable: false,
      reason: FIELD_REASONS.agentBotAuthorOnly,
    })
    expect(fieldRule({ kind: 'agent_work_bot', field: 'name', persona: custom, caller: { ...author, reachesBot: false } })).toEqual({
      editable: false,
      reason: FIELD_REASONS.unreachable,
    })
  })

  it('a bot’s voice is its own, like its face: the bot’s rule, never the agent’s (decision 11)', () => {
    const anchor: PersonaFacts = { kind: 'anchor' }
    // A full teammate's: owners, admins and its team's leads, the agent's author or not.
    expect(editable('agent_teammate', 'voice', owner)).toBe(true)
    expect(editable('role_teammate', 'voice', lead)).toBe(true)
    expect(fieldRule({ kind: 'agent_teammate', field: 'voice', persona: custom, caller: author })).toEqual({
      editable: false,
      reason: FIELD_REASONS.botManagersOnly,
    })
    expect(editable('agent_teammate', 'voice', member)).toBe(false)
    // A system teammate's too, built-in agent or not.
    expect(editable('system_teammate', 'voice', lead, anchor)).toBe(true)
    expect(editable('system_teammate', 'voice', member, anchor)).toBe(false)
    // A loop's bot: any member who reaches it. An agent's work bot: its agent's rule.
    expect(editable('loop_work_bot', 'voice', member, anchor)).toBe(true)
    expect(editable('agent_work_bot', 'voice', author)).toBe(true)
    expect(fieldRule({ kind: 'agent_work_bot', field: 'voice', persona: custom, caller: member })).toEqual({
      editable: false,
      reason: FIELD_REASONS.agentBotAuthorOnly,
    })
    expect(fieldRule({ kind: 'agent_teammate', field: 'voice', persona: custom, caller: { ...owner, reachesBot: false } })).toEqual({
      editable: false,
      reason: FIELD_REASONS.unreachable,
    })
    // Every field's rule is the same as its face's.
    for (const kind of ['agent_teammate', 'role_teammate', 'agent_work_bot', 'system_teammate', 'loop_work_bot'] as BotKind[]) {
      for (const caller of [owner, lead, member, author]) {
        const persona = kind === 'system_teammate' || kind === 'loop_work_bot' ? anchor : custom
        expect(fieldRule({ kind, field: 'voice', persona, caller }), `${kind} ${caller.userId}`).toEqual(fieldRule({ kind, field: 'face', persona, caller }))
      }
    }
  })

  it('a system teammate’s skills keep the teammate rule (it is its own agent)', () => {
    const anchor: PersonaFacts = { kind: 'anchor' }
    expect(editable('system_teammate', 'skills', lead, anchor)).toBe(true)
    expect(editable('system_teammate', 'skills', owner, anchor)).toBe(true)
    expect(editable('system_teammate', 'skills', member, anchor)).toBe(false)
  })

  it('decision 12: only owners and admins set what a bot may change on its own, and only on a full teammate', () => {
    expect(editable('agent_teammate', 'bounds', owner)).toBe(true)
    expect(editable('role_teammate', 'bounds', { userId: 'u-admin', role: 'admin' })).toBe(true)
    expect(fieldRule({ kind: 'agent_teammate', field: 'bounds', persona: custom, caller: lead })).toEqual({
      editable: false,
      reason: FIELD_REASONS.boundsOwnersOnly,
    })
    // The agent's author isn't enough either.
    expect(editable('agent_teammate', 'bounds', author)).toBe(false)
    expect(editable('agent_work_bot', 'bounds', owner)).toBe(false)
    expect(editable('system_teammate', 'bounds', owner, { kind: 'anchor' })).toBe(false)
    expect(editable('loop_work_bot', 'bounds', owner, { kind: 'anchor' })).toBe(false)
  })

  it('routes each kind’s skills: the agent’s route, the teammate’s, or none', () => {
    expect(skillsRouteFor('agent_teammate')).toBe('agent')
    expect(skillsRouteFor('agent_work_bot')).toBe('agent')
    expect(skillsRouteFor('role_teammate')).toBe('agent')
    expect(skillsRouteFor('system_teammate')).toBe('bot')
    expect(skillsRouteFor('loop_work_bot')).toBeNull()
  })

  it('"Make a copy for this bot" points only a bot built on an agent at a copy', () => {
    expect(mayRepointToCopy('agent_teammate')).toBe(true)
    expect(mayRepointToCopy('role_teammate')).toBe(true)
    expect(mayRepointToCopy('agent_work_bot')).toBe(true)
    expect(mayRepointToCopy('system_teammate')).toBe(false)
    expect(mayRepointToCopy('loop_work_bot')).toBe(false)
  })
})

describe('what a bot may change on its own (decision 12)', () => {
  it('reads a bot’s classes as one of the two choices', () => {
    expect(boundsChoiceOf(['read'])).toBe('read')
    expect(boundsChoiceOf(['read', 'internal-write'])).toBe('internal')
    expect(boundsChoiceOf(null)).toBe('read')
  })

  it('takes exactly read, or read and internal writes; never an outside write', () => {
    expect(parseBounds(['read'])).toEqual(['read'])
    expect(parseBounds(['internal-write', 'read'])).toEqual([...BOUNDS_CLASSES.internal])
    expect(parseBounds(['read', 'read'])).toEqual(['read'])
    expect(parseBounds(['read', 'internal-write', 'external-write'])).toBeNull()
    expect(parseBounds(['read', 'external-write'])).toBeNull()
    expect(parseBounds(['internal-write'])).toBeNull()
    expect(parseBounds(['read', 'delete'])).toBeNull()
    expect(parseBounds([])).toBeNull()
    expect(parseBounds('read')).toBeNull()
    expect(parseBounds([1])).toBeNull()
  })
})

describe('skills a bot may always check', () => {
  it('this workspace’s or a system skill, never a personal one', () => {
    expect(isPinnableSkill({ category: 'skill', workspace_id: WS, visibility: 'workspace' }, WS)).toBe(true)
    expect(isPinnableSkill({ category: 'skill', workspace_id: null, is_system: true, visibility: 'workspace' }, WS)).toBe(true)
    expect(isPinnableSkill({ category: 'skill', workspace_id: WS, visibility: 'personal' }, WS)).toBe(false)
    expect(isPinnableSkill({ category: 'skill', workspace_id: 'ws-2', visibility: 'public' }, WS)).toBe(false)
    expect(isPinnableSkill({ category: 'agent', workspace_id: WS, visibility: 'workspace' }, WS)).toBe(false)
    expect(isPinnableSkill(null, WS)).toBe(false)
    expect(MAX_PINNED_SKILLS).toBe(5)
  })
})

describe('the copy’s name', () => {
  it('names the bot it’s for, or says it’s a copy', () => {
    expect(copyNameFor('Researcher', 'Riley')).toBe('Researcher for Riley')
    expect(copyNameFor('Researcher', 'researcher')).toBe('Researcher (copy)')
    expect(copyNameFor(' ', '')).toBe('Agent (copy)')
  })
})

describe('the Assistant edits like a system teammate (bots-v4 Phase 5)', () => {
  it('is a system teammate: only its name, face, voice and skills change', () => {
    const kind = botKindOf({ is_system: true, fronts_only: false, role: null }, personaKindOf({ is_system: false, workspace_id: null, category: 'agent' }, 'ws-1'))
    expect(kind).toBe('system_teammate')
    for (const field of ['agent_name', 'sharing', 'description', 'instructions', 'tools', 'team', 'bounds'] as const) {
      expect(kindAllows(kind, field).editable, field).toBe(false)
    }
    for (const field of ['name', 'face', 'voice', 'skills'] as const) expect(kindAllows(kind, field).editable, field).toBe(true)
    expect(skillsRouteFor(kind)).toBe('bot')
    expect(mayRepointToCopy(kind)).toBe(false)
  })
})
