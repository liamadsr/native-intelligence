/**
 * A coding agent's model and effort (721), as a Mac offers them: the offer
 * keeps a model choice only when the Mac's app says it takes one
 * (`takesModel`), cleaned to ids in the model-choice shape; a start may name
 * only what the offer lists (modelChoiceRefusal); the relay forwards the
 * choice from the desktop's status, and the bridge reads it the same way.
 */
import { describe, expect, it } from 'vitest'
import { heartbeatBody } from '@/lib/local-agent/relay-core'
import { toLocalAgentWorkerOffer } from '@/lib/tauri-bridge'
import { MODEL_CHOICE_RE, OFFERED_EFFORTS_MAX, OFFERED_MODELS_MAX, cleanWorkerOffers, effortsFor, isModelChoice, modelChoiceRefusal, type MacWorkerOffer } from '../types'

const CODEX: MacWorkerOffer = {
  id: 'codex',
  label: 'Codex',
  takesModel: true,
  models: [
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-5.3-mini', label: 'GPT-5.3 mini', efforts: [] },
  ],
  efforts: ['medium'],
}

describe('the model-choice shape', () => {
  it('letters, digits and . - _ : /, 1 to 100 characters', () => {
    for (const ok of ['opus', 'gpt-5.3-codex', 'anthropic/claude:latest_1', 'x'.repeat(100)]) expect(isModelChoice(ok), ok).toBe(true)
    for (const bad of ['', 'two words', 'x'.repeat(101), 'opus;drop', 'ünïcode', null, 4]) expect(isModelChoice(bad), String(bad)).toBe(false)
    expect(MODEL_CHOICE_RE.source).toBe('^[A-Za-z0-9._:/-]{1,100}$')
  })
})

describe('cleanWorkerOffers keeps a model choice only when the app takes one', () => {
  it('an offer without takesModel is the id and label alone, whatever else it says', () => {
    expect(cleanWorkerOffers([{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-5.3-codex' }], efforts: ['high'] }])).toEqual([{ id: 'codex', label: 'Codex' }])
    expect(cleanWorkerOffers([{ id: 'codex', label: 'Codex', takesModel: 'yes', models: [] }])).toEqual([{ id: 'codex', label: 'Codex' }])
  })

  it('with it: models in the shape, once, a plain label (the id when none), their efforts; the default model’s efforts', () => {
    const [offer] = cleanWorkerOffers([
      {
        id: 'codex',
        label: 'Codex',
        takesModel: true,
        models: [
          { id: 'gpt-5.3-codex', label: ' GPT-5.3\u0007 Codex ', efforts: ['high', 'high', 'two words', 7] },
          { id: 'gpt-5.3-codex', label: 'again' },
          { id: 'bad id', label: 'Bad' },
          { id: 'gpt-5.3-mini' },
          'not an object',
        ],
        efforts: ['medium', 'x'.repeat(101)],
        extra: 'dropped',
      },
    ])!
    expect(offer).toEqual({
      id: 'codex',
      label: 'Codex',
      takesModel: true,
      models: [
        { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', efforts: ['high'] },
        { id: 'gpt-5.3-mini', label: 'gpt-5.3-mini', efforts: [] },
      ],
      efforts: ['medium'],
    })
  })

  it('at most OFFERED_MODELS_MAX models and OFFERED_EFFORTS_MAX efforts', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m-${i}`, efforts: Array.from({ length: 20 }, (_, j) => `e${j}`) }))
    const [offer] = cleanWorkerOffers([{ id: 'codex', label: 'Codex', takesModel: true, models: many, efforts: many[0].efforts }])!
    expect(offer.models).toHaveLength(OFFERED_MODELS_MAX)
    expect(offer.models![0].efforts).toHaveLength(OFFERED_EFFORTS_MAX)
    expect(offer.efforts).toHaveLength(OFFERED_EFFORTS_MAX)
  })
})

describe('what a start may name (modelChoiceRefusal)', () => {
  const none = { model: null, effort: null }

  it('the defaults always; anything else only on an offer that takes a model', () => {
    expect(modelChoiceRefusal(null, none, 'Codex')).toBeNull()
    expect(modelChoiceRefusal({ id: 'codex', label: 'Codex' }, none, 'Codex')).toBeNull()
    expect(modelChoiceRefusal({ id: 'codex', label: 'Codex' }, { model: 'gpt-5.3-codex', effort: null }, 'Codex')).toContain('Update the app on that Mac')
    expect(modelChoiceRefusal(undefined, { model: null, effort: 'high' }, 'Codex')).toContain('Update the app on that Mac')
  })

  it('a listed model, and an effort that model takes (with no model, the default model’s)', () => {
    expect(modelChoiceRefusal(CODEX, { model: 'gpt-5.3-codex', effort: 'high' }, 'Codex')).toBeNull()
    expect(modelChoiceRefusal(CODEX, { model: 'gpt-5.3-mini', effort: null }, 'Codex')).toBeNull()
    expect(modelChoiceRefusal(CODEX, { model: null, effort: 'medium' }, 'Codex')).toBeNull()
    expect(modelChoiceRefusal(CODEX, { model: 'gpt-9', effort: null }, 'Codex')).toBe('This Mac doesn’t offer gpt-9 for Codex. Pick another model, or start with its default.')
    expect(modelChoiceRefusal(CODEX, { model: 'gpt-5.3-mini', effort: 'high' }, 'Codex')).toBe('gpt-5.3-mini doesn’t take high effort. Pick another, or start with its default.')
    expect(modelChoiceRefusal(CODEX, { model: null, effort: 'high' }, 'Codex')).toBe('Codex’s default model doesn’t take high effort. Pick another, or start with its default.')
  })

  it('effortsFor: the model’s, or the default model’s with none', () => {
    expect(effortsFor(CODEX, 'gpt-5.3-codex')).toEqual(['low', 'medium', 'high'])
    expect(effortsFor(CODEX, null)).toEqual(['medium'])
    expect(effortsFor(CODEX, 'gpt-9')).toEqual([])
    expect(effortsFor({}, null)).toEqual([])
  })
})

describe('from the desktop’s status to the server', () => {
  const device = { deviceId: '0b5e2d6c-aaaa-4bbb-8ccc-dddddddddddd', name: 'Studio Mac', platform: 'macos', appVersion: '0.2.112' } as never

  it('the relay forwards an agent’s model choice only when the desktop says it takes one', () => {
    const body = heartbeatBody(device, { grants: [], jobs: [], workers: [CODEX, { id: 'claude-code', label: 'Claude Code' }] })
    expect(body.workers).toEqual([CODEX, { id: 'claude-code', label: 'Claude Code' }])
    expect(cleanWorkerOffers(body.workers)).toEqual([CODEX, { id: 'claude-code', label: 'Claude Code' }])
  })

  it('the bridge reads the desktop’s offer the same way', () => {
    expect(toLocalAgentWorkerOffer({ id: 'codex', label: 'Codex', takesModel: true, models: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', efforts: ['high'] }], efforts: [] })).toEqual({
      id: 'codex',
      label: 'Codex',
      takesModel: true,
      models: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', efforts: ['high'] }],
      efforts: [],
    })
    // An older desktop: the id and label alone.
    expect(toLocalAgentWorkerOffer({ id: 'codex', label: 'Codex' })).toEqual({ id: 'codex', label: 'Codex' })
  })
})
