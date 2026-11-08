import { describe, it, expect } from 'vitest'
import {
  clampModelToPlan,
  resolveModel,
  getModelProvider,
  gatewayModelSlug,
  appModelIdFromGatewaySlug,
  usageProviderLabel,
  modelIdentityNote,
  DEFAULT_MODEL,
  DEFAULT_SKILL_RUN_MODEL,
  DEFAULT_SKILL_RUN_MODEL_SLUG,
  PREMIUM_MODELS,
  CHAT_MODELS,
  DEFAULT_CHAT_POLICY,
  FLASH_CHAT_POLICY,
  HELPER_MODELS,
  HELPER_MODEL_FALLBACK,
  HELPER_MODEL_KEYS,
  MAIN_MODEL,
  helperModelForTier,
  helperModelSpecs,
  isPremiumHelperModel,
  renderHelperModelRoster,
  STRONG_MODEL,
  THINKING_LEVELS,
  chatModelPolicy,
  deepseekSurfacePolicy,
  ALLOWED_MODELS,
} from '@/lib/ai/models'

/** The non-Anthropic catalog models (neither is premium). */
const NEW_MODELS = [
  { id: 'deepseek-v4-flash', provider: 'deepseek' },
  { id: 'deepseek-v4-pro', provider: 'deepseek' },
] as const

describe('clampModelToPlan (P1-6)', () => {
  it('lets paid users keep a premium model', () => {
    const premium = [...PREMIUM_MODELS][0]
    expect(clampModelToPlan(premium, true)).toBe(premium)
  })

  it('downgrades free/trial users from premium to the default model', () => {
    const premium = [...PREMIUM_MODELS][0]
    expect(clampModelToPlan(premium, false)).toBe(DEFAULT_MODEL)
  })

  it('leaves the default (cheap) model untouched for free users', () => {
    expect(clampModelToPlan(DEFAULT_MODEL, false)).toBe(DEFAULT_MODEL)
  })

  it('leaves a non-premium model untouched regardless of tier', () => {
    expect(clampModelToPlan(DEFAULT_MODEL, true)).toBe(DEFAULT_MODEL)
  })
})

describe('resolveModel', () => {
  it('falls back to default for unknown models', () => {
    expect(resolveModel('gpt-4')).toBe(DEFAULT_MODEL)
    expect(resolveModel(null)).toBe(DEFAULT_MODEL)
  })

  it('accepts each new multi-provider model', () => {
    for (const { id } of NEW_MODELS) {
      expect(resolveModel(id)).toBe(id)
    }
  })

  it('defaults to DEFAULT_MODEL when no fallback is given (chat/live-agent callers)', () => {
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL)
    expect(resolveModel('')).toBe(DEFAULT_MODEL)
  })

  it('honors an explicit fallback for an absent/unknown model (flows engine)', () => {
    expect(resolveModel(undefined, DEFAULT_SKILL_RUN_MODEL)).toBe(DEFAULT_SKILL_RUN_MODEL)
    expect(resolveModel(null, DEFAULT_SKILL_RUN_MODEL)).toBe(DEFAULT_SKILL_RUN_MODEL)
    expect(resolveModel('gpt-4', DEFAULT_SKILL_RUN_MODEL)).toBe(DEFAULT_SKILL_RUN_MODEL)
  })

  it('a valid model wins over the fallback', () => {
    // An allowed model is returned as-is regardless of the fallback.
    expect(resolveModel('deepseek-v4-pro', DEFAULT_SKILL_RUN_MODEL)).toBe('deepseek-v4-pro')
    expect(resolveModel(DEFAULT_MODEL, DEFAULT_SKILL_RUN_MODEL)).toBe(DEFAULT_MODEL)
  })
})

describe('DEFAULT_MODEL (the one code-level default)', () => {
  it('is DeepSeek V4 Flash — the cheapest catalog model — and a real, allowed id', () => {
    expect(DEFAULT_MODEL).toBe('deepseek-v4-flash')
    expect(ALLOWED_MODELS.has(DEFAULT_MODEL)).toBe(true)
  })

  it('is not premium, so a free/trial user is never clamped away from it', () => {
    expect(PREMIUM_MODELS.has(DEFAULT_MODEL)).toBe(false)
  })
})

describe('DEFAULT_SKILL_RUN_MODEL (historical alias of DEFAULT_MODEL)', () => {
  it('is a real, allowed CHAT_MODELS id (so it never falls through resolveModel)', () => {
    expect(ALLOWED_MODELS.has(DEFAULT_SKILL_RUN_MODEL)).toBe(true)
  })

  it('is the same DeepSeek Flash id as DEFAULT_MODEL — every surface shares one code default', () => {
    expect(DEFAULT_SKILL_RUN_MODEL).toBe('deepseek-v4-flash')
    expect(DEFAULT_SKILL_RUN_MODEL).toBe(DEFAULT_MODEL)
  })

  it('is not a premium model (an unpaid loop run is never clamped away from it)', () => {
    expect(PREMIUM_MODELS.has(DEFAULT_SKILL_RUN_MODEL)).toBe(false)
    expect(clampModelToPlan(DEFAULT_SKILL_RUN_MODEL, false)).toBe(DEFAULT_SKILL_RUN_MODEL)
  })
})

describe('DEFAULT_SKILL_RUN_MODEL_SLUG (shared gateway slug for background jobs)', () => {
  it('is the gateway-qualified `${provider}/${id}` form of the skill-run default', () => {
    // The single source of truth the nightly weaver, brief compilation, and
    // claim extraction pass to aiModel(...). Kept in lockstep with the id +
    // provider so those jobs never hardcode a copied slug string.
    expect(DEFAULT_SKILL_RUN_MODEL_SLUG).toBe(
      `${getModelProvider(DEFAULT_SKILL_RUN_MODEL)}/${DEFAULT_SKILL_RUN_MODEL}`,
    )
    expect(DEFAULT_SKILL_RUN_MODEL_SLUG).toBe('deepseek/deepseek-v4-flash')
  })

  it('splits back into a (provider-label, bare-model) pair that matches its pricing row', () => {
    // Background-job logUsage derives provider/model from the model actually
    // running: a non-Anthropic provider is logged verbatim, and the bare id is
    // the slug tail — the exact pair ai_model_costs is keyed on.
    expect(usageProviderLabel(DEFAULT_SKILL_RUN_MODEL)).toBe('deepseek')
    expect(DEFAULT_SKILL_RUN_MODEL_SLUG.split('/')[1]).toBe(DEFAULT_SKILL_RUN_MODEL)
  })
})

describe('multi-provider CHAT_MODELS', () => {
  it('exposes the DeepSeek models in CHAT_MODELS with the correct provider', () => {
    for (const { id, provider } of NEW_MODELS) {
      const entry = CHAT_MODELS.find((m) => m.id === id)
      expect(entry, `CHAT_MODELS missing ${id}`).toBeDefined()
      expect(entry?.provider).toBe(provider)
    }
  })

  it('accepts each new model in ALLOWED_MODELS', () => {
    for (const { id } of NEW_MODELS) {
      expect(ALLOWED_MODELS.has(id)).toBe(true)
    }
  })

  it('is MAIN_MODEL, the tiers\' and the helper roster\'s models plus the eval judges\' (no Kimi)', () => {
    expect(CHAT_MODELS.map((m) => m.id).sort()).toEqual(
      [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-haiku-5-5',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'deepseek-v4-flash',
        'deepseek-v4-pro',
      ].sort(),
    )
  })

  it('MAIN_MODEL is Haiku 5.5 on the Gateway (Liam, 2026-10-27), priced as Claude', () => {
    expect(MAIN_MODEL).toBe('claude-haiku-5-5')
    expect(gatewayModelSlug(MAIN_MODEL)).toBe('anthropic/claude-haiku-5.5')
    expect(usageProviderLabel(MAIN_MODEL)).toBe('claude')
    expect(usageProviderLabel('gpt-5.6-terra')).toBe('openai')
  })

  it('STRONG_MODEL is the newest Sonnet on the Gateway (5.5), premium, and priced as Claude', () => {
    expect(STRONG_MODEL).toBe('claude-sonnet-5-5')
    expect(gatewayModelSlug(STRONG_MODEL)).toBe('anthropic/claude-sonnet-5.5')
    expect(PREMIUM_MODELS.has(STRONG_MODEL)).toBe(true)
    expect(clampModelToPlan(STRONG_MODEL, false)).toBe(DEFAULT_MODEL)
    expect(usageProviderLabel(STRONG_MODEL)).toBe('claude')
  })

  it('keeps every CHAT_MODELS id unique (no cross-provider collisions)', () => {
    const ids = CHAT_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('getModelProvider', () => {
  it('returns the provider for each known model', () => {
    expect(getModelProvider('claude-haiku-4-5-20251001')).toBe('anthropic')
    expect(getModelProvider('claude-sonnet-4-5-20250929')).toBe('anthropic')
    for (const { id, provider } of NEW_MODELS) {
      expect(getModelProvider(id)).toBe(provider)
    }
  })

  it('falls back to anthropic for unknown ids', () => {
    expect(getModelProvider('gpt-4')).toBe('anthropic')
    expect(getModelProvider('')).toBe('anthropic')
  })
})

describe('usageProviderLabel', () => {
  it('maps Anthropic models to the legacy claude literal', () => {
    // The log_ai_usage RPC's prompt-cache discount branch matches 'claude'
    // exactly, so Anthropic ids MUST keep logging 'claude' (not 'anthropic').
    expect(usageProviderLabel('claude-haiku-4-5-20251001')).toBe('claude')
    expect(usageProviderLabel('claude-sonnet-4-5-20250929')).toBe('claude')
  })

  it('logs non-Anthropic providers verbatim', () => {
    expect(usageProviderLabel('deepseek-v4-flash')).toBe('deepseek')
    expect(usageProviderLabel('deepseek-v4-pro')).toBe('deepseek')
  })

  it('falls back to claude for unknown ids (preserves legacy behavior)', () => {
    expect(usageProviderLabel('gpt-4')).toBe('claude')
  })

  it("bills a step on the person's ChatGPT plan to the plan, under either name eve gives it", () => {
    expect(usageProviderLabel('chatgpt-plan/gpt-6-luna')).toBe('chatgpt-plan')
    expect(usageProviderLabel('openai/gpt-6.1-sol')).toBe('chatgpt-plan')
    // The usage readers normalize a step id first: a plan search step gets its plan name back.
    expect(appModelIdFromGatewaySlug('openai/gpt-6-luna')).toBe('chatgpt-plan/gpt-6-luna')
    expect(appModelIdFromGatewaySlug('chatgpt-plan/gpt-6.1-sol')).toBe('chatgpt-plan/gpt-6.1-sol')
    expect(appModelIdFromGatewaySlug('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol')
  })
})

describe('modelIdentityNote (routing-truth self-identity line)', () => {
  it('uses the CHAT_MODELS label + Gateway catalog slug for a known Anthropic model', () => {
    const note = modelIdentityNote('claude-haiku-4-5-20251001')
    expect(note).toContain('Active model: Haiku 4.5')
    expect(note).toContain('`anthropic/claude-haiku-4.5`')
  })

  it('is history-proof: pins to the CURRENT reply and forbids training-data / earlier-turn identities', () => {
    // Live E2E failure this guards: turn 4 (back on haiku, after a thread with
    // three different prior identity answers) hallucinated "Claude 3.5 Sonnet"
    // because the softer single-sentence line was ignored. The strengthened copy
    // must (a) pin to the current reply, (b) warn earlier statements may be
    // outdated because turns ran on different models, and (c) forbid answering
    // from training data OR from an earlier turn.
    const note = modelIdentityNote('claude-haiku-4-5-20251001')
    expect(note).toContain('CURRENT reply')
    expect(note).toMatch(/different turns.*may have run on different models/)
    expect(note).toMatch(/may be outdated/)
    expect(note).toMatch(/never a model name from your training data/)
    expect(note).toMatch(/never one quoted from an earlier turn/)
  })

  it('names the Strong tier model by its label and catalog slug', () => {
    const note = modelIdentityNote(STRONG_MODEL)
    expect(note).toContain('Sonnet 5.5')
    expect(note).toContain('`anthropic/claude-sonnet-5.5`')
  })

  it('names DeepSeek correctly', () => {
    const note = modelIdentityNote('deepseek-v4-flash')
    expect(note).toContain('DeepSeek V4 Flash')
    expect(note).toContain('`deepseek/deepseek-v4-flash`')
  })

  it('degrades gracefully for an unknown id (bare id as label, anthropic default provider)', () => {
    const note = modelIdentityNote('gpt-4')
    // Unknown label falls back to the bare id; provider falls back to anthropic —
    // still a well-formed note.
    expect(note).toContain('Active model: gpt-4')
    expect(note).toContain('`anthropic/gpt-4`')
  })

  it('is deterministic and varies only with the model (cache-safe)', () => {
    // Same input → byte-identical output (no timestamps / nondeterminism), so the
    // prepended note never spuriously invalidates the per-model prompt cache.
    expect(modelIdentityNote('deepseek-v4-flash')).toBe(modelIdentityNote('deepseek-v4-flash'))
    expect(modelIdentityNote('deepseek-v4-flash')).not.toBe(modelIdentityNote('deepseek-v4-pro'))
  })
})

describe('clampModelToPlan with new models (P1-6)', () => {
  it('does NOT clamp the DeepSeek models for free/trial users (neither is premium)', () => {
    for (const { id } of NEW_MODELS) {
      expect(PREMIUM_MODELS.has(id)).toBe(false)
      expect(clampModelToPlan(id, false)).toBe(id)
      expect(clampModelToPlan(id, true)).toBe(id)
    }
  })
})

describe('gatewayModelSlug (Gateway CATALOG slug, not the dated app id)', () => {
  // Prod outage 2026-09-02: eve ≥0.47 resolves every dynamic model selection
  // against GET /v1/models/catalog BY SLUG for context-window metadata. The
  // dated Anthropic app ids ('claude-haiku-4-5-20251001') are provider model
  // ids, NOT catalog slugs — sending them failed every chat turn with "AI
  // Gateway did not provide context window metadata". These pin the mapping.
  it('maps the dated Anthropic ids to their dotted catalog slugs', () => {
    expect(gatewayModelSlug('claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5')
    expect(gatewayModelSlug('claude-sonnet-4-5-20250929')).toBe('anthropic/claude-sonnet-4.5')
  })

  it('maps the DeepSeek ids and Sonnet 5.5 to provider-qualified slugs', () => {
    expect(gatewayModelSlug('claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5.5')
    expect(gatewayModelSlug('deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash')
    expect(gatewayModelSlug('deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro')
  })

  it('passes an already-qualified slug through unchanged', () => {
    expect(gatewayModelSlug('anthropic/claude-opus-4.8')).toBe('anthropic/claude-opus-4.8')
    expect(gatewayModelSlug('moonshotai/kimi-k3')).toBe('moonshotai/kimi-k3')
  })

  it('degrades an unknown bare id to provider/id (routes rather than throws)', () => {
    expect(gatewayModelSlug('gpt-99')).toBe('anthropic/gpt-99')
  })

  it('every CHAT_MODELS gatewayId is a qualified slug with no Anthropic date suffix', () => {
    for (const m of CHAT_MODELS) {
      expect(m.gatewayId, m.id).toMatch(/^[a-z]+\/[a-z0-9.-]+$/)
      expect(m.gatewayId, m.id).not.toMatch(/-\d{8}$/)
      expect(gatewayModelSlug(m.id)).toBe(m.gatewayId)
    }
  })

  it('DEFAULT_SKILL_RUN_MODEL_SLUG is the catalog slug of the skill-run default', () => {
    expect(DEFAULT_SKILL_RUN_MODEL_SLUG).toBe(gatewayModelSlug(DEFAULT_SKILL_RUN_MODEL))
  })
})

describe('DEFAULT_CHAT_POLICY and the windows (how chat calls each model)', () => {
  it('pins each window to the smallest one its allowed hosts accept as chat calls it', () => {
    // Checked 2026-09-30 against the Gateway catalog (see chatModelPolicy in
    // models.ts). Sonnet 4.5's catalog 1M is the context-1m beta, which needs a
    // header nothing sends, so it gets the 200K every host serves without it.
    // Sonnet 5.5 serves 1M with no beta. Raising a window is a fresh catalog
    // check, not a fix.
    expect(Object.fromEntries(CHAT_MODELS.map((m) => [m.id, chatModelPolicy(m.id, 'light').contextWindowTokens]))).toEqual({
      'claude-haiku-4-5-20251001': 200_000,
      'claude-sonnet-4-5-20250929': 200_000,
      'claude-sonnet-5-5': 1_000_000,
      'claude-opus-5-5': 1_000_000,
      'claude-haiku-5-5': 1_000_000,
      'gpt-5.6-terra': 1_000_000,
      'gpt-5.6-luna': 1_000_000,
      'deepseek-v4-flash': 1_000_000,
      'deepseek-v4-pro': 1_000_000,
    })
  })

  it('pins the exact reviewed DeepSeek host lists, ranked by first-token latency', () => {
    // Owner decision (2026-09-29), each host checked against
    // /v1/models/<slug>/endpoints for both privacy flags, a >=1M window and
    // thinking-off. Widening either list is a decision for the owner and a fresh
    // endpoints check, not a capacity fix: deepinfra serves Pro at 64K and
    // digitalocean serves Flash at 262K, both under the 1M window above. Chat
    // always thinks, so Flash in chat runs only on the hosts that reason fully;
    // the thinking-off list is the other surfaces' (deepseekSurfacePolicy 'off').
    expect(FLASH_CHAT_POLICY.gateway).toEqual({ only: ['wafer', 'alibaba'], sort: 'ttft' })
    expect(deepseekSurfacePolicy('deepseek-v4-flash', 'off')?.gateway).toEqual({ only: ['baseten', 'wafer', 'deepinfra', 'alibaba'], sort: 'ttft' })
    expect(chatModelPolicy('deepseek-v4-pro', 'light').gateway).toEqual({ only: ['baseten', 'alibaba'], sort: 'ttft' })
  })

  it('DEFAULT_CHAT_POLICY is the main chat\'s Haiku 5.5; chat\'s DeepSeek thinks at both levels, in both encodings', () => {
    // Liam, 2026-10-31: Flash with thinking off wrote its reasoning into the
    // reply a guest was texted. In chat, DeepSeek never runs with it off.
    expect(DEFAULT_CHAT_POLICY).toEqual(chatModelPolicy(MAIN_MODEL, 'light'))
    expect(DEFAULT_CHAT_POLICY).toEqual({ contextWindowTokens: 1_000_000 })
    expect(FLASH_CHAT_POLICY).toEqual(chatModelPolicy('deepseek-v4-flash', 'light'))
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro'] as const) {
      for (const level of THINKING_LEVELS) {
        const policy = chatModelPolicy(id, level)
        expect(policy.reasoning, `${id} ${level}`).toBe('high')
        expect(policy.providerOptions, `${id} ${level}`).toEqual({ deepseek: { thinking: { type: 'enabled' } } })
        expect(policy.gateway?.sort, `${id} ${level}`).toBe('ttft')
      }
    }
  })

  it('DeepSeek never routes to azure (inverts thinking-off) or a host without both privacy flags', () => {
    // Owner decision (2026-09-29): zero-data-retention and no-training hosts
    // only. novita and gmicloud train on prompts; DeepSeek's own API carries
    // neither flag. Adding one of these is a decision for the owner, not a fix.
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro'] as const) {
      for (const level of THINKING_LEVELS) {
        for (const host of ['azure', 'novita', 'gmicloud', 'deepseek']) {
          expect(chatModelPolicy(id, level).gateway?.only, `${id} ${level} → ${host}`).not.toContain(host)
        }
      }
    }
  })
})

describe('thinking levels (the tiers\' two)', () => {
  it('has Light (Fast) and Standard (Think) only: no slider, and Max is never picked', () => {
    expect(THINKING_LEVELS).toEqual(['light', 'standard'])
  })
})

describe('chatModelPolicy (how chat calls each model at each level)', () => {
  const FLASH_THINKING = { only: ['wafer', 'alibaba'], sort: 'ttft' }
  const PRO = { only: ['baseten', 'alibaba'], sort: 'ttft' }
  const ON = { deepseek: { thinking: { type: 'enabled' } } }

  it('pins every (model, level) policy', () => {
    const table = Object.fromEntries(CHAT_MODELS.flatMap((m) => THINKING_LEVELS.map((l) => [`${m.id} ${l}`, chatModelPolicy(m.id, l)])))
    expect(table).toEqual({
      'claude-haiku-4-5-20251001 light': { contextWindowTokens: 200_000 },
      'claude-haiku-4-5-20251001 standard': { contextWindowTokens: 200_000, reasoning: 'minimal' },
      'claude-sonnet-4-5-20250929 light': { contextWindowTokens: 200_000 },
      'claude-sonnet-4-5-20250929 standard': { contextWindowTokens: 200_000, reasoning: 'minimal' },
      // Sonnet 5.5 refuses thinking off: no reasoning at either level (adaptive at its default effort).
      'claude-sonnet-5-5 light': { contextWindowTokens: 1_000_000 },
      'claude-sonnet-5-5 standard': { contextWindowTokens: 1_000_000 },
      // Opus and Haiku 5.5 likewise: adaptive thinking, the same at both levels.
      'claude-opus-5-5 light': { contextWindowTokens: 1_000_000 },
      'claude-opus-5-5 standard': { contextWindowTokens: 1_000_000 },
      'claude-haiku-5-5 light': { contextWindowTokens: 1_000_000 },
      'claude-haiku-5-5 standard': { contextWindowTokens: 1_000_000 },
      'gpt-5.6-terra light': { contextWindowTokens: 1_000_000, reasoning: 'low' },
      'gpt-5.6-terra standard': { contextWindowTokens: 1_000_000, reasoning: 'medium' },
      'gpt-5.6-luna light': { contextWindowTokens: 1_000_000, reasoning: 'low' },
      'gpt-5.6-luna standard': { contextWindowTokens: 1_000_000, reasoning: 'medium' },
      'deepseek-v4-flash light': { contextWindowTokens: 1_000_000, reasoning: 'high', providerOptions: ON, gateway: FLASH_THINKING },
      'deepseek-v4-flash standard': { contextWindowTokens: 1_000_000, reasoning: 'high', providerOptions: ON, gateway: FLASH_THINKING },
      'deepseek-v4-pro light': { contextWindowTokens: 1_000_000, reasoning: 'high', providerOptions: ON, gateway: PRO },
      'deepseek-v4-pro standard': { contextWindowTokens: 1_000_000, reasoning: 'high', providerOptions: ON, gateway: PRO },
    })
  })

  it('never sends xhigh (Max is never picked automatically)', () => {
    for (const m of CHAT_MODELS) for (const level of THINKING_LEVELS) expect(chatModelPolicy(m.id, level).reasoning).not.toBe('xhigh')
  })

  it('Flash thinks only on the hosts that reason fully (never baseten or deepinfra)', () => {
    const only = chatModelPolicy('deepseek-v4-flash', 'standard').gateway?.only
    expect(only).not.toContain('baseten')
    expect(only).not.toContain('deepinfra')
  })

  it('no level changes a window', () => {
    for (const m of CHAT_MODELS) expect(chatModelPolicy(m.id, 'standard').contextWindowTokens).toBe(chatModelPolicy(m.id, 'light').contextWindowTokens)
  })
})

describe('appModelIdFromGatewaySlug (the model an eve step ran → the usage-row model id)', () => {
  it('maps every catalog slug back to its app id (inverse of gatewayModelSlug)', () => {
    for (const m of CHAT_MODELS) {
      expect(appModelIdFromGatewaySlug(m.gatewayId)).toBe(m.id)
      expect(appModelIdFromGatewaySlug(gatewayModelSlug(m.id))).toBe(m.id)
    }
  })
  it('passes a known app id through and strips the provider of an unknown slug', () => {
    expect(appModelIdFromGatewaySlug('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(appModelIdFromGatewaySlug('anthropic/claude-opus-9')).toBe('claude-opus-9')
  })
  it('null on empty / non-string input', () => {
    expect(appModelIdFromGatewaySlug('')).toBeNull()
    expect(appModelIdFromGatewaySlug('  ')).toBeNull()
    expect(appModelIdFromGatewaySlug(undefined)).toBeNull()
    expect(appModelIdFromGatewaySlug(42)).toBeNull()
    expect(appModelIdFromGatewaySlug('anthropic/')).toBeNull()
  })
})

describe('deepseekSurfacePolicy (DeepSeek on the surfaces other than chat)', () => {
  it("'on' is chat's policy (it always thinks); 'off' is the same hosts' thinking-off call, for both DeepSeek models", () => {
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro'] as const) {
      expect(deepseekSurfacePolicy(id, 'on'), id).toEqual(chatModelPolicy(id, 'standard'))
      expect(deepseekSurfacePolicy(id, 'on'), id).toEqual(chatModelPolicy(id, 'light'))
      expect(deepseekSurfacePolicy(id, 'off'), id).toMatchObject({ reasoning: 'none', providerOptions: { deepseek: { thinking: { type: 'disabled' } } } })
    }
  })

  it('thinking on keeps Flash off the hosts that cut its reasoning short', () => {
    expect(deepseekSurfacePolicy('deepseek-v4-flash', 'on')).toEqual({
      contextWindowTokens: 1_000_000,
      reasoning: 'high',
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
      gateway: { only: ['wafer', 'alibaba'], sort: 'ttft' },
    })
    expect(deepseekSurfacePolicy('deepseek-v4-flash', 'off')).toMatchObject({
      reasoning: 'none',
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    })
  })

  it('takes a Gateway slug as well as an app id', () => {
    expect(deepseekSurfacePolicy('deepseek/deepseek-v4-pro', 'on')).toEqual(chatModelPolicy('deepseek-v4-pro', 'standard'))
  })

  it('leaves every other model, and an unknown id, unchanged', () => {
    for (const m of ['claude-sonnet-4-5-20250929', 'anthropic/claude-haiku-4.5', 'kimi-k2.6', 'moonshotai/kimi-k3', 'gpt-4', '']) {
      expect(deepseekSurfacePolicy(m, 'on'), m).toBeUndefined()
      expect(deepseekSurfacePolicy(m, 'off'), m).toBeUndefined()
    }
  })
})

describe('the helper roster (HELPER_MODELS: the main agent picks each helper\'s model)', () => {
  it('has one entry per key, in key order, each on a CHAT_MODELS model', () => {
    expect(HELPER_MODELS.map((m) => m.key)).toEqual([...HELPER_MODEL_KEYS])
    for (const m of HELPER_MODELS) expect(ALLOWED_MODELS.has(m.model), m.key).toBe(true)
  })

  it('runs each tier\'s old model when the rules pick, and the fallback is Flash thinking', () => {
    expect(helperModelForTier('fast')).toBe('flash')
    expect(helperModelForTier('think')).toBe('flash-thinking')
    expect(helperModelForTier('strong')).toBe('sonnet')
    expect(HELPER_MODELS.find((m) => m.key === 'sonnet')?.model).toBe(STRONG_MODEL)
    expect(HELPER_MODELS.find((m) => m.key === 'opus')?.model).toBe('claude-opus-5-5')
    expect(HELPER_MODELS.find((m) => m.key === 'haiku')?.model).toBe(MAIN_MODEL)
    expect(HELPER_MODEL_FALLBACK).toBe('flash-thinking')
    expect(isPremiumHelperModel(HELPER_MODEL_FALLBACK)).toBe(false)
  })

  it('the premium models are exactly the ones above $1 per 1M input tokens', () => {
    expect(HELPER_MODEL_KEYS.filter(isPremiumHelperModel)).toEqual(['sonnet', 'gpt-terra', 'opus'])
  })

  it('the spec\'s helperModels carry each model\'s slug, policy and identity line', () => {
    const specs = helperModelSpecs()
    expect(Object.keys(specs)).toEqual([...HELPER_MODEL_KEYS])
    expect(specs.flash).toEqual({ model: 'deepseek/deepseek-v4-flash', modelPolicy: FLASH_CHAT_POLICY, identityNote: modelIdentityNote('deepseek-v4-flash'), tier: 'fast' })
    expect(specs['flash-thinking'].modelPolicy).toEqual(chatModelPolicy('deepseek-v4-flash', 'standard'))
    expect(specs.opus.model).toBe('anthropic/claude-opus-5.5')
    expect(specs['gpt-terra']).toMatchObject({ model: 'openai/gpt-5.6-terra', tier: 'strong', modelPolicy: { reasoning: 'medium' } })
  })

  it('the roster names every key and the cap, and is stable text', () => {
    const roster = renderHelperModelRoster(10)
    expect(roster).toMatch(/^## Models for helpers\n/)
    for (const key of HELPER_MODEL_KEYS) expect(roster).toContain(`| \`${key}\` |`)
    expect(roster).toContain('at most 10 premium helpers a day')
    // On Haiku the main agent does most work itself, and hands off batches,
    // background jobs and work that needs a stronger model (Liam, 2026-10-27).
    expect(roster).toContain('so you do most of the work yourself')
    expect(roster).toMatch(/Writing copy[^\n]*do it yourself/)
    expect(roster).toMatch(/Code, SQL[^\n]*`sonnet`/)
    expect(roster).toMatch(/A change to a code repository is a coding run/)
    expect(roster).toBe(renderHelperModelRoster(10))
    expect(roster).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('opens with the model the main agent runs on: Auto\'s, or the one the person picked', () => {
    expect(renderHelperModelRoster(10)).toContain('you run on a fast, inexpensive model (Claude Haiku 5.5), so you do most of the work yourself.')
    expect(renderHelperModelRoster(10, null)).toBe(renderHelperModelRoster(10))
    const opus = renderHelperModelRoster(10, { name: 'Claude Opus 5.5', premium: true })
    expect(opus).toContain('you run on a strong model the person chose for you (Claude Opus 5.5), so you do most of the work yourself.')
    expect(opus).not.toContain('Claude Haiku 5.5),')
    const luna = renderHelperModelRoster(10, { name: 'GPT-5.6 Luna', premium: false })
    expect(luna).toContain('you run on a fast, inexpensive model the person chose for you (GPT-5.6 Luna)')
    // Only the opening changes: the roster itself is the same for every pick.
    expect(opus.split('\n').slice(3)).toEqual(renderHelperModelRoster(10).split('\n').slice(3))
  })
})
