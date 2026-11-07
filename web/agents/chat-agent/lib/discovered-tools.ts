/**
 * The tool names `search_tools` discovered in this session
 * (../tools/workspace_tools.ts). `step.started` re-derives the advertised set
 * from this (eve does NOT persist step tool metadata, so the resolver MUST
 * rebuild the expanded set from durable state every step). Survives step
 * boundaries + crashes.
 *
 * Every name here has its definition (name, description, input schema) sent
 * on every model call, so the set is dropped once the conversation it was
 * found in is summarized away (./context-reset.ts): before that, a long-lived
 * main chat kept every tool it ever searched for. On PROD (10-27) the
 * always-on chat's tool definitions had grown from 24K to 46K tokens a call
 * over 97 turns.
 *
 * Its own module so the reset can reach it without loading the tools resolver.
 */
import { defineState } from 'eve/context'

const discoveredTools = defineState<string[]>('chat-agent.discovered-tools', () => [])

/** The names discovered this session (a helper's resolver reads its own session's). */
export function discoveredToolNames(): string[] {
  return discoveredTools.get()
}

/** Record names a search matched, so the next step advertises them. */
export function addDiscoveredTools(names: readonly string[]): void {
  discoveredTools.update((prev) => {
    const set = new Set(prev)
    for (const n of names) set.add(n)
    return [...set]
  })
}

/** Back to the core set: what a search found before is gone with its history. */
export function resetDiscoveredTools(): void {
  discoveredTools.update(() => [])
}
