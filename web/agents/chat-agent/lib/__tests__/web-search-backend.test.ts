/**
 * Pins eve's Exa PIN SEMANTICS — the invariant our `webSearch({ provider: 'exa' })`
 * files silently depend on.
 *
 * ── The trap ────────────────────────────────────────────────────────────────
 * Every one of our agents authors `tools/web_search.ts` as
 * `webSearch({ provider: 'exa' })`. That looks like an unconditional pin. It is
 * NOT. eve's backend resolver (`resolveWebSearchBackend` in
 * node_modules/eve/dist/src/harness/provider-tools.js, reading the model's
 * profile from harness/model-profile.js `resolveModelProfile`, eve 0.75.1+)
 * honours the configured provider ONLY for an AI Gateway model, which is what a
 * bare model-id string (or a `{ model, modelOptions }` selection) resolves to.
 * For a DIRECT-SDK provider instance authored in agent.ts (e.g. `anthropic(...)`),
 * the pin is IGNORED and the backend is the provider's native search:
 *
 *   openai.*     → 'openai'    (native OpenAI search)
 *   anthropic.*  → 'anthropic' (native Anthropic search)
 *   google.*     → 'google'    (Google search grounding, Gemini 3+)
 *   anything else → null      → the harness DELETES web_search entirely
 *
 * So swapping any agent's model from a gateway string to a direct-SDK instance
 * would, for a non-native provider (DeepSeek, Moonshot/Kimi), remove web search
 * from that agent with NO type error, NO build failure, and NO test going red —
 * the tool would just stop existing at runtime.
 *
 * ── Why this is latent, not broken ──────────────────────────────────────────
 * Every agent uses gateway STRINGS today:
 *   • chat-agent / skill-runner / coding-agent / work-agent — `defineDynamic`
 *     resolvers whose `modelSelectionFromSpec` returns a string or
 *     `{ model, modelOptions }` (lib/spec-client.ts), never a provider instance.
 *   • onboarding-researcher — static `'deepseek/deepseek-v4-flash'`.
 * Hence `source === undefined` everywhere and the Exa pin holds. This test locks
 * that in so the day someone reaches for a direct provider instance, case (b)
 * below explains what they just broke.
 *
 * ── Reaching the resolver ───────────────────────────────────────────────────
 * `resolveWebSearchBackend` is not on eve's public surface: the package's
 * `exports` map has no `./dist/*` wildcard, so `import 'eve/dist/...'` is blocked
 * by export encapsulation. We import the dist file by ABSOLUTE PATH instead,
 * which bypasses the exports map. That makes the import a version-coupled probe
 * into eve's internals — deliberately so, because the semantics it pins are also
 * internal. If a future eve upgrade moves or renames it, the `beforeAll` below
 * fails LOUDLY with instructions to re-verify the pin by hand rather than
 * quietly skipping and leaving the invariant unguarded.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** eve's internal resolver, reached by absolute path (see header). */
const PROVIDER_TOOLS_DIST = fileURLToPath(
  new URL('../../../../node_modules/eve/dist/src/harness/provider-tools.js', import.meta.url),
)

/**
 * Loud failure message for the day the internal path moves. The point is that
 * nobody "fixes" this by deleting the test: the pin semantics still need
 * checking against the new eve, by hand, before this file is re-pointed.
 */
const MOVED =
  `eve's internal web-search backend resolver is no longer at ${PROVIDER_TOOLS_DIST}. ` +
  `Do NOT delete this test. Re-read eve's harness for resolveWebSearchBackend (or its ` +
  `successor), confirm by hand that a GATEWAY model reference still honours ` +
  `webSearch({ provider: 'exa' }) and that a SOURCE-BACKED non-native provider still ` +
  `loses web_search, then re-point this file at the new location.`

/** eve's model profile input: a Gateway id string, or a LanguageModel's `provider` / `modelId`. */
type Model = string | { provider: string; modelId: string }
type Profile = { gateway: boolean; provider: string }
type Resolve = (model: Model, configured?: string) => string | null

const MODEL_PROFILE_DIST = fileURLToPath(
  new URL('../../../../node_modules/eve/dist/src/harness/model-profile.js', import.meta.url),
)

let resolveWebSearchBackend: Resolve

beforeAll(async () => {
  expect(existsSync(PROVIDER_TOOLS_DIST), MOVED).toBe(true)
  expect(existsSync(MODEL_PROFILE_DIST), MOVED).toBe(true)
  const tools = (await import(pathToFileURL(PROVIDER_TOOLS_DIST).href)) as Record<string, unknown>
  const profiles = (await import(pathToFileURL(MODEL_PROFILE_DIST).href)) as Record<string, unknown>
  expect(typeof tools.resolveWebSearchBackend, MOVED).toBe('function')
  expect(typeof profiles.resolveModelProfile, MOVED).toBe('function')
  const backend = tools.resolveWebSearchBackend as (profile: Profile, handling?: { provider: string }) => string | null
  const profile = profiles.resolveModelProfile as (model: Model) => Profile
  // As eve's harness calls them: the step's resolved model → its profile, and the
  // web_search tool's provider-tool handling (`webSearch({ provider })`).
  resolveWebSearchBackend = (model, configured) =>
    backend(profile(model), configured === undefined ? undefined : { provider: configured })
})

/**
 * Every model id the fleet can actually run on, Gateway-qualified exactly as the
 * agents produce them:
 *   • an Anthropic gateway id (the static agents ran on it before #362)
 *   • every CHAT_MODELS id (src/lib/ai/models.ts) after the
 *     `${provider}/${id}` qualification modelSelectionFromSpec applies
 * Listed literally rather than imported: the eve agent trees cannot import from
 * src/, and a literal list is what makes a future model addition show up here as
 * a deliberate edit.
 */
const FLEET_GATEWAY_MODEL_IDS = [
  'anthropic/claude-sonnet-5', // the static agents' model before #362
  'anthropic/claude-haiku-4-5-20251001',
  'anthropic/claude-sonnet-4-5-20250929',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k3',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
] as const

describe('eve web-search backend — the Exa pin holds for gateway models', () => {
  // (a) What our agents actually produce today: a Gateway model id. The
  // configured provider wins for EVERY provider prefix —
  // including the non-Anthropic ones, which is the whole point of pinning Exa.
  for (const id of FLEET_GATEWAY_MODEL_IDS) {
    it(`${id} (gateway string, no source) resolves to exa`, () => {
      expect(resolveWebSearchBackend(id, 'exa')).toBe('exa')
    })
  }

  it('the Gateway LanguageModel eve resolves an id to holds the pin too', () => {
    expect(resolveWebSearchBackend({ provider: 'gateway', modelId: 'deepseek/deepseek-v4-flash' }, 'exa')).toBe('exa')
  })

  it('honours the pin with no explicit argument (exa is eve’s own default)', () => {
    expect(resolveWebSearchBackend('deepseek/deepseek-v4-flash')).toBe('exa')
  })
})

describe('eve web-search backend — the TRAP: a direct-SDK model ignores the pin', () => {
  // (b) THE REGRESSION THIS FILE EXISTS FOR. Authoring a direct-SDK provider
  // instance in agent.ts makes eve derive the backend from the provider
  // instead of the pin. For DeepSeek/Kimi there is no native search, so the
  // resolver returns null and buildToolSetWithProviderTools `delete`s
  // web_search from the tool set — the agent silently loses web access. Keep
  // every agent on a gateway model string.
  it('deepseek direct => null (web_search is DELETED, not Exa-backed)', () => {
    expect(resolveWebSearchBackend({ provider: 'deepseek.chat', modelId: 'deepseek-v4-flash' }, 'exa')).toBeNull()
  })

  it('moonshotai direct => null (same silent loss)', () => {
    expect(resolveWebSearchBackend({ provider: 'moonshotai.chat', modelId: 'kimi-k2.6' }, 'exa')).toBeNull()
  })

  it('anthropic direct => native anthropic search, NOT the pinned exa', () => {
    // Not a null, but still not what the pin asked for: a different backend with
    // a different result schema. Documented so nobody reads "it still works" as
    // "the pin was honoured".
    expect(resolveWebSearchBackend({ provider: 'anthropic.messages', modelId: 'claude-sonnet-5' }, 'exa')).toBe(
      'anthropic',
    )
  })
})
