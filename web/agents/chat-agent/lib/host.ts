/**
 * Which body of the one Dial8 agent this build is (contract C2,
 * docs/plans/teammate-agent.md): the same source, built twice.
 *
 *   - 'cloud': the Vercel build, as it has always been. The default: nothing
 *     sets DIAL8_AGENT_HOST there, so every switch below keeps today's path.
 *   - 'mac': the desktop bundle (scripts/local-agent/build.sh and bundle.sh set
 *     DIAL8_AGENT_HOST=mac for `eve build`). The launcher sets it again in the
 *     eve server's environment, because eve compiles each module at build time
 *     and imports it again at runtime, and both must see the same host.
 *
 * Read at module evaluation by the files that differ between the bodies
 * (agent.ts, channels/eve.ts, the harness and web tools, lib/spec-client.ts),
 * so eve's compiled manifest is decided by the build's environment. The
 * Mac-only slots eve needs a file for (sandbox.ts, finish, the fence prompt)
 * are not here at all: they are the Mac host's own files in agents/local-agent,
 * which the Mac build adds (scripts/local-agent/mac-body.sh).
 *
 * Fails closed on anything it doesn't know: a typo must not silently build the
 * other body, and the Mac body never runs on Vercel.
 */
export type AgentHost = 'cloud' | 'mac'

/** The environment variable the Mac build and the launcher set. */
export const AGENT_HOST_ENV = 'DIAL8_AGENT_HOST'

type HostEnv = Readonly<Record<string, string | undefined>>

/** The host this process was built and launched for. Throws on an unknown value, or 'mac' on Vercel. */
export function agentHost(env: HostEnv = process.env): AgentHost {
  const raw = env[AGENT_HOST_ENV]
  if (raw === undefined || raw === '' || raw === 'cloud') return 'cloud'
  if (raw !== 'mac') throw new Error(`[chat-agent] ${AGENT_HOST_ENV}=${JSON.stringify(raw)} is not a host (cloud or mac)`)
  if (env.VERCEL) throw new Error(`[chat-agent] ${AGENT_HOST_ENV}=mac on Vercel: the Mac body never runs there`)
  return 'mac'
}

/** True in the desktop bundle's build and its eve server. */
export function isMacHost(env: HostEnv = process.env): boolean {
  return agentHost(env) === 'mac'
}
