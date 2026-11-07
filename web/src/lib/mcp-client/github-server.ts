/**
 * The GitHub integration's MCP server as plain facts (github-integration.ts
 * builds it). No imports, so the approval policy (safe in client code) and the
 * MCP client read them without pulling in the loader.
 */

/**
 * Its id wherever a connection id goes: the adapter's meta, a loop's call_tool
 * step, a skill step's `connections`, a held call's card. A fixed uuid (those
 * places check the shape; `6769` is "gi"), never a connected_mcp_server row's:
 * code that knows nothing of it looks for a row and finds none, which fails
 * safe. Every by-id lookup that knows it builds the server from the caller's
 * own integration (owner-connection.ts loadOwnerConnection, index.ts
 * callToolByServerId).
 */
export const GITHUB_INTEGRATION_SERVER_ID = '00000000-6769-4000-8000-000000000001'

/** Its name: the `github` in every `mcp__github__<tool>` name, and the prompt block's line. */
export const GITHUB_SERVER_DISPLAY_NAME = 'GitHub'

/** GitHub's hosted MCP server, read-only by its URL. */
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly'

/**
 * GitHub's own read-only MCP endpoints (`/mcp/readonly`, `/mcp/x/<toolset>/readonly`):
 * the server lists no write tool there and refuses one by name, whatever is
 * asked, so every tool on it is a read whatever it is called. Whoever added
 * the server (the integration, or a person's own connector at that URL), the
 * guarantee is GitHub's; the client never follows a redirect off it.
 */
export function isGitHubReadOnlyServerUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      u.hostname === 'api.githubcopilot.com' &&
      !u.port &&
      !u.search &&
      /^\/mcp(\/x\/[a-z_]+)?\/readonly\/?$/.test(u.pathname)
    )
  } catch {
    return false
  }
}
