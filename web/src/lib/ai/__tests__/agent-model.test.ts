/**
 * The picks for a person's main agent (../agent-model.ts). Pinned: only
 * models the Gateway serves that the app already runs and meters (CHAT_MODELS
 * entries with a catalog slug, on the helper roster, never a ChatGPT plan
 * model, never MAIN_MODEL, which is Auto); the roster's strong models are the
 * premium ones; a saved value is checked, and a premium pick needs a paid
 * plan.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_MODEL_IDS,
  AGENT_MODEL_OPTIONS,
  AUTO_AGENT_MODEL,
  AUTO_AGENT_MODEL_DESCRIPTION,
  agentModelForTurn,
  agentModelName,
  isPremiumAgentModel,
  parseAgentModel,
  parseAgentModelChoice,
} from '../agent-model'
import { CHAT_MODELS, HELPER_MODELS, MAIN_MODEL, gatewayModelSlug } from '../models'
import { PLAN_MODELS } from '@/lib/chatgpt/plan-models'

describe('the picks', () => {
  it('are models the Gateway serves and the app already runs with the chat\'s tools and meters', () => {
    for (const id of AGENT_MODEL_IDS) {
      const entry = CHAT_MODELS.find((m) => m.id === id)
      expect(entry, id).toBeDefined()
      expect(gatewayModelSlug(id), id).toBe(entry!.gatewayId)
      expect(HELPER_MODELS.some((m) => m.model === id), id).toBe(true)
      expect(PLAN_MODELS.has(id), id).toBe(false)
    }
  })

  it('leave MAIN_MODEL to Auto, which names it', () => {
    expect(AGENT_MODEL_IDS as readonly string[]).not.toContain(MAIN_MODEL)
    expect(agentModelName(null)).toBe('Claude Haiku 5.5')
    expect(AUTO_AGENT_MODEL_DESCRIPTION.startsWith('Claude Haiku 5.5')).toBe(true)
  })

  it('mark the roster\'s strong models premium', () => {
    expect(AGENT_MODEL_IDS.filter(isPremiumAgentModel)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.6-terra'])
    expect(AGENT_MODEL_OPTIONS.map((o) => [o.id, o.label, o.premium])).toEqual([
      ['claude-opus-5-5', 'Claude Opus 5.5', true],
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5', true],
      ['gpt-5.6-terra', 'GPT-5.6 Terra', true],
      ['gpt-5.6-luna', 'GPT-5.6 Luna', false],
      ['deepseek-v4-flash', 'DeepSeek V4 Flash', false],
    ])
    for (const o of AGENT_MODEL_OPTIONS) expect(o.description.length, o.id).toBeGreaterThan(0)
  })
})

describe('parsing', () => {
  it('a saved pick: a model id, or null (Auto) for anything else', () => {
    expect(parseAgentModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    for (const raw of [null, undefined, '', 'auto', 'claude-haiku-5-5', 'anthropic/claude-opus-5.5', 'gpt-6.1-sol', 42, {}]) {
      expect(parseAgentModel(raw), String(raw)).toBeNull()
    }
  })

  it('a sent choice: auto or a pick, null for anything else', () => {
    expect(parseAgentModelChoice(AUTO_AGENT_MODEL)).toBe('auto')
    expect(parseAgentModelChoice('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(parseAgentModelChoice('Auto')).toBeNull()
    expect(parseAgentModelChoice(null)).toBeNull()
  })
})

describe('agentModelForTurn', () => {
  it('runs the pick on a paid plan, Auto for nothing saved', () => {
    expect(agentModelForTurn('claude-opus-5-5', true)).toBe('claude-opus-5-5')
    expect(agentModelForTurn(null, true)).toBeNull()
    expect(agentModelForTurn('not-a-model', true)).toBeNull()
  })

  it('runs Auto for a premium pick without a paid plan, but an inexpensive pick as saved', () => {
    for (const premium of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.6-terra']) expect(agentModelForTurn(premium, false), premium).toBeNull()
    expect(agentModelForTurn('gpt-5.6-luna', false)).toBe('gpt-5.6-luna')
    expect(agentModelForTurn('deepseek-v4-flash', false)).toBe('deepseek-v4-flash')
  })
})
