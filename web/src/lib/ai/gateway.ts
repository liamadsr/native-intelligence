/**
 * Model factory for the two eval graders ONLY (src/lib/evals/graders/judges.ts
 * and match-proposals.ts), the founder exception to "every model call runs on
 * eve". Every other model call runs on an eve agent, which resolves models on
 * its own; src/lib/ai/__tests__/eve-everywhere-tripwire.test.ts refuses an
 * `aiModel` import anywhere else.
 *
 * Pass a Gateway CATALOG slug like 'anthropic/claude-sonnet-4.5' (build it with
 * `gatewayModelSlug()` from @/lib/ai/models — never `${provider}/${appId}`) to
 * route through the Vercel AI Gateway (default), or set `USE_GATEWAY=false` to bypass
 * Gateway and call the provider directly via @ai-sdk/anthropic.
 *
 * The kill switch now covers only the graders: eve agents never read
 * USE_GATEWAY. Follow-up (docs/plans/eve-everywhere-cutover.md §d): once the
 * graders move to the decision model, drop this switch and the
 * @ai-sdk/anthropic dependency.
 *
 * Usage:
 *   import { aiModel } from '@/lib/ai/gateway'
 *   const result = await generateText({
 *     model: aiModel('anthropic/claude-sonnet-4.5'),
 *     ...
 *   })
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'

/**
 * Gateway is on by default. Set USE_GATEWAY=false in env to bypass.
 * Any value other than exactly 'false' keeps Gateway enabled.
 */
function isGatewayEnabled(): boolean {
  return process.env.USE_GATEWAY !== 'false'
}

// Lazy provider singletons for the fallback path — only instantiated if Gateway is disabled
let _anthropicProvider: ReturnType<typeof createAnthropic> | null = null
function getAnthropicProvider() {
  if (!_anthropicProvider) {
    _anthropicProvider = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }
  return _anthropicProvider
}

/**
 * Resolves a slug like 'anthropic/claude-sonnet-4.5' into a model
 * the AI SDK can use.
 *
 * When Gateway is enabled (default): returns the slug as-is. The AI SDK v6
 * routes plain `provider/model` strings through Gateway automatically.
 *
 * When Gateway is disabled: strips the provider prefix and calls the direct
 * provider SDK instead.
 */
export function aiModel(slug: string): LanguageModel {
  if (isGatewayEnabled()) {
    // Gateway native routing — just pass the string through.
    return slug
  }

  // Kill-switch fallback: strip provider prefix and call direct SDK.
  const [provider, ...rest] = slug.split('/')
  const modelId = rest.join('/')

  switch (provider) {
    case 'anthropic':
      return getAnthropicProvider()(modelId)
    default:
      throw new Error(
        `aiModel kill switch: no direct fallback configured for provider "${provider}". ` +
          `Add one in src/lib/ai/gateway.ts, or re-enable Gateway by unsetting USE_GATEWAY.`,
      )
  }
}
