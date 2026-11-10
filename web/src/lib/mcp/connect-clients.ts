/**
 * Settings › Native Intelligence MCP's "Pick your app": how each AI app adds Native Intelligence's MCP
 * server (src/lib/mcp/server.ts, OAuth with dynamic client registration, so
 * every app signs in with a Native Intelligence login and no key), as close to one click as
 * that app allows. Checked against each vendor's docs on 2026-10-22:
 *
 *   one-click   the app's own https install page (it hands off to the app):
 *               Cursor (cursor.com/install-mcp) and VS Code
 *               (vscode.dev/redirect/mcp/install → vscode:mcp/install).
 *               https, so it opens from the desktop app too (open-external.ts
 *               allows only http(s)).
 *   command     one line to paste in a terminal: Claude Code, Codex, Gemini CLI,
 *               added for the user (every folder), not just the one it ran in.
 *   steps       no install link exists: the URL to paste and where (Claude,
 *               ChatGPT). Both connect from their own cloud, so they need the
 *               public URL.
 *
 * Any other app: OTHER_APP_HINT, a line under the tiles.
 *
 * Left out: LM Studio has an install page too, but its MCP support documents
 * only a fixed header (a bearer token), no OAuth sign-in, so Native Intelligence would be
 * added and then refused. Windsurf is now Devin Desktop, whose default agent
 * keeps its MCP servers in the Devin CLI's config, not the old
 * mcp_config.json: until that settles, the hint covers it.
 *
 * Pure: no React, no window. The page passes the server (nativeintelligence.dev, or the
 * dev origin on localhost) and renders what comes back.
 */

export type ConnectClientId =
  | 'claude'
  | 'chatgpt'
  | 'cursor'
  | 'vscode'
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'

/** The server an app adds: its name in that app, and its URL. */
export interface ConnectServer {
  name: string
  url: string
}

/** Something to paste: a terminal command or a config file's text. */
export interface ConnectSnippet {
  label: string
  text: string
}

export interface ConnectClient {
  id: ConnectClientId
  name: string
  /** The tile's one-word how. */
  how: 'One click' | 'Command' | 'Steps'
  /** One click: the app's own https install page, and its button's words. */
  install?: { label: string; href: (server: ConnectServer) => string }
  /** Lines to paste, in order. */
  snippets?: (server: ConnectServer) => ConnectSnippet[]
  /** Numbered steps, for an app with no install link. */
  steps?: string[]
  /** A button straight to the right place in the app. */
  open?: { label: string; href: string }
  /** One more line under the steps (plans, teams). */
  note?: string
  /** Connects from the app's own cloud: a localhost URL can't reach it. */
  cloud?: boolean
}

/** Native Intelligence's MCP endpoint on an origin. */
export function connectServer(origin: string, local: boolean): ConnectServer {
  return { name: local ? 'native-intelligence-dev' : 'native-intelligence', url: `${origin.replace(/\/+$/, '')}/api/mcp` }
}

/** Base64 of an ASCII JSON string (a server URL and a name are ASCII). */
function base64(text: string): string {
  return typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'utf8').toString('base64')
}

/** Cursor's own install page: base64 of the server's mcp.json entry. */
export function cursorInstallUrl({ name, url }: ConnectServer): string {
  return `https://cursor.com/install-mcp?name=${encodeURIComponent(name)}&config=${encodeURIComponent(base64(JSON.stringify({ url })))}`
}

/** VS Code's redirect: it opens vscode:mcp/install with the http server entry. */
export function vscodeInstallUrl({ name, url }: ConnectServer): string {
  return `https://vscode.dev/redirect/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify({ type: 'http', url }))}`
}

/** The order the tiles show: the apps most people use first. */
export const CONNECT_CLIENTS: readonly ConnectClient[] = [
  {
    id: 'claude',
    name: 'Claude',
    how: 'Steps',
    open: { label: 'Open Claude connectors', href: 'https://claude.ai/customize/connectors' },
    steps: [
      'In Claude (web or desktop app), open Customize › Connectors.',
      'Click + Add, then Add custom connector.',
      'Name it Native Intelligence, paste the server URL, and click Continue, then Continue again.',
      'Choose to sign in now, click Add, and sign in with your Native Intelligence account.',
    ],
    note: 'On a Team or Enterprise plan, an owner adds it once in Organization settings › Connectors (Add › Custom › Web); then everyone connects their own account from Customize › Connectors.',
    cloud: true,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    how: 'Steps',
    open: { label: 'Open ChatGPT plugins', href: 'https://chatgpt.com/plugins' },
    steps: [
      'In ChatGPT, open Plugins, click +, then Add custom MCP server.',
      'Name it Native Intelligence, add a short description, and paste the server URL.',
      'Choose OAuth for authentication, read the warning, and click Create as a plugin.',
      'Sign in with your Native Intelligence account when ChatGPT asks.',
    ],
    note: 'In a Business or Enterprise workspace, an admin may need to allow custom MCP servers first.',
    cloud: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    how: 'One click',
    install: { label: 'Add to Cursor', href: cursorInstallUrl },
    snippets: ({ name, url }) => [{ label: 'Or add it to ~/.cursor/mcp.json', text: JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2) }],
  },
  {
    id: 'vscode',
    name: 'VS Code',
    how: 'One click',
    install: { label: 'Add to VS Code', href: vscodeInstallUrl },
    snippets: ({ name, url }) => [{ label: 'Or run', text: `code --add-mcp '${JSON.stringify({ name, type: 'http', url })}'` }],
    note: 'Native Intelligence shows up in GitHub Copilot’s agent mode.',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    how: 'Command',
    snippets: ({ name, url }) => [
      { label: 'Run in your terminal', text: `claude mcp add --scope user --transport http ${name} ${url}` },
      { label: `Then in Claude Code, run /mcp, pick ${name} and sign in`, text: '/mcp' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    how: 'Command',
    snippets: ({ name, url }) => [
      { label: 'Run in your terminal', text: `codex mcp add ${name} --url ${url}` },
      { label: 'If no sign-in opened, run', text: `codex mcp login ${name}` },
    ],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    how: 'Command',
    snippets: ({ name, url }) => [
      { label: 'Run in your terminal', text: `gemini mcp add --scope user --transport http ${name} ${url}` },
      { label: 'Then in Gemini CLI, sign in', text: `/mcp auth ${name}` },
    ],
  },
]

/** For an app with no tile: what any MCP app takes. */
export const OTHER_APP_HINT =
  'Another app? Add a remote MCP server (HTTP) with the server URL, then sign in with your Native Intelligence account when it asks.'

export function connectClient(id: ConnectClientId): ConnectClient {
  return CONNECT_CLIENTS.find((c) => c.id === id) ?? CONNECT_CLIENTS[0]
}

/** An app that connects from its own cloud can't reach a localhost server. */
export function unreachableFrom(client: Pick<ConnectClient, 'cloud'>, server: ConnectServer): boolean {
  if (!client.cloud) return false
  try {
    const host = new URL(server.url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}
