/**
 * The Mac host's code the chat agent calls (contract C2,
 * docs/plans/teammate-agent.md): the one door from agents/chat-agent into
 * agents/local-agent.
 *
 * In this tree, and so in the cloud build, these are stubs that throw: every
 * caller sits behind isMacHost() (lib/host.ts), and nothing from
 * agents/local-agent (the relay's provider, a local model's provider) is
 * imported, so none of it can reach the Vercel bundle. The Mac build
 * (scripts/local-agent/mac-body.sh) overwrites this file in its throwaway copy
 * with re-exports of the real ones, as it swaps the channel; a test
 * (__tests__/mac-slots.test.ts) keeps the two export lists equal.
 */
import type { LanguageModel } from 'ai'

type ModelEnv = Readonly<Record<string, string | undefined>>

function macOnly(name: string): never {
  throw new Error(`[chat-agent] ${name} runs in the Mac body only (scripts/local-agent/mac-body.sh)`)
}

/** agents/local-agent/lib/model.ts: the relay, a model on the Mac, or the dev key. */
export function createLocalAgentModel(_env?: ModelEnv): LanguageModel {
  return macOnly('createLocalAgentModel')
}

/**
 * agents/local-agent/lib/model.ts: this step's model on the person's own
 * ChatGPT plan (the relay's token says so), or null.
 */
export function localAgentPlanStep(_env?: ModelEnv): {
  model: LanguageModel
  modelContextWindowTokens: number
  reasoning: 'medium'
  modelOptions: { providerOptions: { openai: { store: false } } }
} | null {
  return macOnly('localAgentPlanStep')
}

/** agents/local-agent/lib/model.ts: the session token from the launcher's file. */
export function readModelToken(_tokenFile: string): string {
  return macOnly('readModelToken')
}

/** agents/local-agent/lib/model.ts: the relay URL's rule. */
export function relayBaseUrl(_raw: string | undefined): string | null {
  return macOnly('relayBaseUrl')
}

/** agents/local-agent/lib/model.ts (F-web's L4): eve's window for this launch's model, after a local model's probe. */
export function resolveLocalAgentContextWindow(_env?: ModelEnv): Promise<number> {
  return macOnly('resolveLocalAgentContextWindow')
}

/** agents/local-agent/lib/model.ts (F-web's L4): the same window without waiting (a local model's 32K floor until its probe ran). */
export function localAgentContextWindow(_env?: ModelEnv): number {
  return macOnly('localAgentContextWindow')
}

/** agents/local-agent/lib/mode-instructions.ts: the read or edit mode text. */
export function modeInstructions(_mode: string | undefined): string {
  return macOnly('modeInstructions')
}
