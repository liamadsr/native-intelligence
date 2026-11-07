/**
 * agent-config.ts — the one schema for a recipe's agent_config and the write
 * policy behind it (Sequence step 1, the D.1 lockdown).
 *
 * Pinned:
 *   - parseAgentConfig validates WITHOUT stripping: the contract keys survive,
 *     unknown keys are an error, response_style takes the object and the
 *     legacy string, null is a valid (clearing) value.
 *   - applyAgentConfigUpdate carries an omitted contract key over from the
 *     stored config and refuses to CHANGE one unless the caller is an owner or
 *     admin. Re-sending the same value is not a change.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_CONFIG_CONTRACT_KEYS,
  AGENT_CONFIG_CONTRACT_LOCKED_ERROR,
  applyAgentConfigUpdate,
  canChangeAgentContract,
  parseAgentConfig,
} from '../agent-config'

describe('parseAgentConfig', () => {
  it('keeps every known key, including the three contract keys', () => {
    const out = parseAgentConfig({
      enabled_tools: ['actions'],
      disabled_tools: ['delete_action'],
      capture_mode: 'assist_only',
      output_contract: 'verdict',
      preconditions: ['calendar_connected'],
      response_style: { tone: 'direct', format: 'structured', always_cite_sources: true },
      context_rules: ['Cite the transcript'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.config).toMatchObject({
      capture_mode: 'assist_only',
      output_contract: 'verdict',
      preconditions: ['calendar_connected'],
    })
    for (const key of AGENT_CONFIG_CONTRACT_KEYS) expect(out.config).toHaveProperty(key)
  })

  it('rejects an unknown key instead of dropping it', () => {
    const out = parseAgentConfig({ enabled_tools: [], is_system: true })
    expect(out).toMatchObject({ ok: false, code: 'AGENT_CONFIG_INVALID' })
    if (out.ok) return
    expect(out.error).toMatch(/is_system|unrecognized/i)
  })

  it('rejects a bad contract value', () => {
    expect(parseAgentConfig({ output_contract: 'json' }).ok).toBe(false)
    expect(parseAgentConfig({ capture_mode: 'silent' }).ok).toBe(false)
    expect(parseAgentConfig({ preconditions: ['has_budget'] }).ok).toBe(false)
  })

  it('accepts response_style as the persisted object or the legacy string', () => {
    expect(parseAgentConfig({ response_style: 'terse bullets' }).ok).toBe(true)
    expect(parseAgentConfig({ response_style: { tone: 'warm' } }).ok).toBe(true)
    expect(parseAgentConfig({ response_style: 7 }).ok).toBe(false)
  })

  it('null clears; an array or scalar is not a config', () => {
    expect(parseAgentConfig(null)).toEqual({ ok: true, config: null })
    expect(parseAgentConfig([]).ok).toBe(false)
    expect(parseAgentConfig('x').ok).toBe(false)
    expect(parseAgentConfig(undefined).ok).toBe(false)
  })
})

describe('canChangeAgentContract', () => {
  it('is owner/admin only', () => {
    expect(canChangeAgentContract('owner')).toBe(true)
    expect(canChangeAgentContract('admin')).toBe(true)
    expect(canChangeAgentContract('member')).toBe(false)
    expect(canChangeAgentContract(null)).toBe(false)
    expect(canChangeAgentContract(undefined)).toBe(false)
  })
})

describe('applyAgentConfigUpdate', () => {
  const stored = { enabled_tools: ['actions'], output_contract: 'verdict', preconditions: ['has_actions'] }

  it('carries omitted contract keys over from the stored config (never strips them)', () => {
    const out = applyAgentConfigUpdate({ existing: stored, incoming: { enabled_tools: ['captures'] }, role: 'member' })
    expect(out).toEqual({
      ok: true,
      config: { enabled_tools: ['captures'], output_contract: 'verdict', preconditions: ['has_actions'] },
    })
  })

  it('a member re-sending the SAME contract values is not a contract change', () => {
    const out = applyAgentConfigUpdate({
      existing: stored,
      incoming: { enabled_tools: [], output_contract: 'verdict', preconditions: ['has_actions'] },
      role: 'member',
    })
    expect(out.ok).toBe(true)
  })

  it('refuses a contract CHANGE from a member (403 material), allows it for an admin/owner', () => {
    const flip = { enabled_tools: ['actions'], output_contract: 'prose' }
    expect(applyAgentConfigUpdate({ existing: stored, incoming: flip, role: 'member' })).toEqual({
      ok: false,
      error: AGENT_CONFIG_CONTRACT_LOCKED_ERROR,
      code: 'AGENT_CONFIG_CONTRACT_LOCKED',
    })
    expect(applyAgentConfigUpdate({ existing: stored, incoming: flip, role: 'admin' })).toMatchObject({
      ok: true,
      config: { output_contract: 'prose', preconditions: ['has_actions'] },
    })
    expect(applyAgentConfigUpdate({ existing: stored, incoming: flip, role: 'owner' }).ok).toBe(true)
  })

  it('adding a contract key where none was stored is a change too', () => {
    const out = applyAgentConfigUpdate({
      existing: { enabled_tools: [] },
      incoming: { enabled_tools: [], capture_mode: 'assist_only' },
      role: 'member',
    })
    expect(out).toMatchObject({ ok: false, code: 'AGENT_CONFIG_CONTRACT_LOCKED' })
  })

  it('null clears the config — a contract change when any contract key was stored', () => {
    expect(applyAgentConfigUpdate({ existing: stored, incoming: null, role: 'member' })).toMatchObject({
      ok: false,
      code: 'AGENT_CONFIG_CONTRACT_LOCKED',
    })
    expect(applyAgentConfigUpdate({ existing: stored, incoming: null, role: 'owner' })).toEqual({ ok: true, config: null })
    expect(applyAgentConfigUpdate({ existing: { enabled_tools: ['actions'] }, incoming: null, role: 'member' })).toEqual({
      ok: true,
      config: null,
    })
  })

  it('an invalid incoming config is rejected before any policy check', () => {
    const out = applyAgentConfigUpdate({ existing: stored, incoming: { bogus: 1 }, role: 'owner' })
    expect(out).toMatchObject({ ok: false, code: 'AGENT_CONFIG_INVALID' })
  })
})

describe('the agent-authored marker (F1, src/lib/flows/skill-tool-profile.ts)', () => {
  it('is a known key, and a Library save that omits it keeps it', () => {
    expect(parseAgentConfig({ authored_by: 'agent', enabled_tools: ['emails'] })).toMatchObject({ ok: true })
    expect(parseAgentConfig({ authored_by: 'person' })).toMatchObject({ ok: false })
    expect(
      applyAgentConfigUpdate({ existing: { authored_by: 'agent' }, incoming: { enabled_tools: ['documents'] }, role: 'member' }),
    ).toEqual({ ok: true, config: { enabled_tools: ['documents'], authored_by: 'agent' } })
  })
})

describe('the live-playbook flag (src/lib/live-agent/call-playbooks.ts)', () => {
  it('is a known key, carried over when a save omits it', () => {
    expect(parseAgentConfig({ live_playbook: true }).ok).toBe(true)
    const out = applyAgentConfigUpdate({ existing: { live_playbook: true }, incoming: { context_rules: [] }, role: 'member' })
    expect(out).toEqual({ ok: true, config: { context_rules: [], live_playbook: true } })
  })

  it('any member may turn it on or off', () => {
    expect(applyAgentConfigUpdate({ existing: {}, incoming: { live_playbook: true }, role: 'member' })).toEqual({
      ok: true,
      config: { live_playbook: true },
    })
    expect(applyAgentConfigUpdate({ existing: { live_playbook: true }, incoming: { live_playbook: false }, role: 'member' })).toEqual({
      ok: true,
      config: { live_playbook: false },
    })
  })
})
