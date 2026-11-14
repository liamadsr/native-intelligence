/**
 * Where the app dispatches its OWN eve agents (skill-runner, utility, the
 * coding-agent and work-agent runs, and the agent-run follow-up chat): the
 * app's own address, NEXT_PUBLIC_APP_URL, else local dev's default. The agents
 * are mounted under it (/eve/<name>), and they call back to the app the same
 * way (agents/*\/lib/spec-client.ts).
 *
 * Read from the setting, never from the incoming request's Host: these calls
 * carry internal secrets, and a header a caller can set must not pick where
 * they go.
 */
export function eveDispatchOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}
