/**
 * Settings › Dial8 MCP's per-app install paths (connect-clients.ts): the
 * one-click links carry exactly Dial8's server in each app's own format, and
 * the commands and config snippets name it the same way.
 */
import { describe, it, expect } from 'vitest'
import {
  CONNECT_CLIENTS,
  connectClient,
  connectServer,
  cursorInstallUrl,
  unreachableFrom,
  vscodeInstallUrl,
} from '../connect-clients'

const prod = connectServer('https://dial8.ai', false)

describe('the server', () => {
  it('is dial8 at dial8.ai, and dial8-dev on a local origin', () => {
    expect(prod).toEqual({ name: 'dial8', url: 'https://dial8.ai/api/mcp' })
    expect(connectServer('http://localhost:3000/', true)).toEqual({ name: 'dial8-dev', url: 'http://localhost:3000/api/mcp' })
  })
})

describe('one-click links', () => {
  const params = (href: string) => new URL(href).searchParams

  it('Cursor: its own install page, the mcp.json entry in base64', () => {
    const href = cursorInstallUrl(prod)
    expect(href.startsWith('https://cursor.com/install-mcp?')).toBe(true)
    expect(params(href).get('name')).toBe('dial8')
    expect(JSON.parse(Buffer.from(params(href).get('config')!, 'base64').toString('utf8'))).toEqual({ url: 'https://dial8.ai/api/mcp' })
  })

  it('VS Code: its redirect to vscode:mcp/install, the http server entry as JSON', () => {
    const href = vscodeInstallUrl(prod)
    expect(href.startsWith('https://vscode.dev/redirect/mcp/install?')).toBe(true)
    expect(params(href).get('name')).toBe('dial8')
    expect(JSON.parse(params(href).get('config')!)).toEqual({ type: 'http', url: 'https://dial8.ai/api/mcp' })
  })

  it('every one-click app has an https install link (the desktop app opens only http(s))', () => {
    for (const client of CONNECT_CLIENTS.filter((c) => c.how === 'One click')) {
      expect(client.install, client.id).toBeDefined()
      expect(new URL(client.install!.href(prod)).protocol, client.id).toBe('https:')
    }
  })
})

describe('commands and snippets', () => {
  const texts = (id: Parameters<typeof connectClient>[0]) => connectClient(id).snippets!(prod).map((s) => s.text)

  it('the terminal apps add the same server, with sign-in where the app needs a step for it', () => {
    expect(texts('claude-code')).toEqual(['claude mcp add --scope user --transport http dial8 https://dial8.ai/api/mcp', '/mcp'])
    expect(texts('codex')).toEqual(['codex mcp add dial8 --url https://dial8.ai/api/mcp', 'codex mcp login dial8'])
    expect(texts('gemini-cli')).toEqual(['gemini mcp add --scope user --transport http dial8 https://dial8.ai/api/mcp', '/mcp auth dial8'])
    expect(texts('vscode')).toEqual([`code --add-mcp '{"name":"dial8","type":"http","url":"https://dial8.ai/api/mcp"}'`])
  })

  it('Cursor’s mcp.json entry is the url alone (no auth block: Cursor registers itself)', () => {
    expect(JSON.parse(texts('cursor')[0])).toEqual({ mcpServers: { dial8: { url: 'https://dial8.ai/api/mcp' } } })
  })
})

describe('the apps', () => {
  it('every app says how: an install link, something to paste, or steps', () => {
    for (const client of CONNECT_CLIENTS) {
      expect(!!client.install || !!client.snippets || !!client.steps?.length, client.id).toBe(true)
    }
    expect(new Set(CONNECT_CLIENTS.map((c) => c.id)).size).toBe(CONNECT_CLIENTS.length)
  })

  it('Claude and ChatGPT connect from their own cloud: a localhost server is out of their reach', () => {
    const local = connectServer('http://localhost:3000', true)
    expect(unreachableFrom(connectClient('claude'), local)).toBe(true)
    expect(unreachableFrom(connectClient('chatgpt'), local)).toBe(true)
    expect(unreachableFrom(connectClient('cursor'), local)).toBe(false)
    expect(unreachableFrom(connectClient('claude'), prod)).toBe(false)
  })
})
