import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An app that names itself with a client metadata document (an https
 * client_id, lib/mcp/client-metadata.ts) through the MCP OAuth steps:
 * nothing is fetched for a signed-out request, the document's own redirect
 * URIs are the only ones a browser goes to, and only approve (the person's
 * yes) writes the client row the code points at.
 */

const ID = 'https://app.example.com/oauth/client.json'
const CALLBACK = 'http://127.0.0.1:33418/callback'
const DOC = {
  client_id: ID,
  client_name: 'Example App',
  redirect_uris: [CALLBACK, 'https://app.example.com/cb'],
  token_endpoint_auth_method: 'none',
}

const m = vi.hoisted(() => ({
  user: null as { id: string } | null,
  doc: null as unknown,
  row: null as Record<string, unknown> | null,
  rowLookups: 0,
  upserts: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  upsertError: null as { message: string } | null,
  fetches: 0,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            m.rowLookups++
            return { data: m.row, error: null }
          },
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        m.order.push(`upsert:${table}`)
        m.upserts.push(row)
        return { error: m.upsertError }
      },
      insert: async (row: Record<string, unknown>) => {
        m.order.push(`insert:${table}`)
        m.inserts.push(row)
        return { error: null }
      },
    }),
  }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }))
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => (m.user ? { user: m.user } : new Response('no', { status: 401 })),
}))
vi.mock('@/lib/mcp/client-metadata-fetch', () => ({
  fetchMetadataDocument: async () => {
    m.fetches++
    return { body: m.doc, cacheControl: 'no-store' }
  },
}))

const { GET: authorize } = await import('../authorize/route')
const { POST: approve } = await import('../approve/route')
const { POST: deny } = await import('../deny/route')
const { POST: clientInfo } = await import('../client-info/route')
const { GET: serverMetadata } = await import('@/app/.well-known/oauth-authorization-server/route')
const { _resetClientMetadataCacheForTests } = await import('@/lib/mcp/client-metadata')

const authorizeUrl = (params: Record<string, string>) =>
  new Request(`https://dial8.ai/api/mcp/oauth/authorize?${new URLSearchParams({ code_challenge: 'c', code_challenge_method: 'S256', ...params })}`)
const post = (path: string, body: unknown) => new Request(`https://dial8.ai/api/mcp/oauth/${path}`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  _resetClientMetadataCacheForTests()
  m.user = null
  m.doc = { ...DOC }
  m.row = null
  m.rowLookups = 0
  m.upserts = []
  m.inserts = []
  m.order = []
  m.upsertError = null
  m.fetches = 0
  process.env.NEXT_PUBLIC_APP_URL = 'https://dial8.ai'
})

describe('GET /api/mcp/oauth/authorize, an https client_id', () => {
  it('signed out: straight to Dial8 login, nothing fetched, nothing stored', async () => {
    const res = await authorize(authorizeUrl({ client_id: ID, redirect_uri: CALLBACK }))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(m.fetches).toBe(0)
    expect(m.upserts).toHaveLength(0)
  })

  it('signed out: a client_id URL Dial8 would never fetch is a 400, not a login', async () => {
    for (const client_id of ['https://localhost/client.json', 'https://10.0.0.5/client.json', 'https://app.example.com/a/../client.json']) {
      const res = await authorize(authorizeUrl({ client_id, redirect_uri: CALLBACK }))
      expect(res.status, client_id).toBe(400)
      expect((await res.json()).error, client_id).toBe('invalid_client')
    }
    expect(m.fetches).toBe(0)
  })

  it('signed in: the document is fetched and the consent page opens (it asks the server for the name); no row yet', async () => {
    m.user = { id: 'u1' }
    const res = await authorize(authorizeUrl({ client_id: ID, redirect_uri: CALLBACK, state: 's' }))
    const to = new URL(res.headers.get('location')!)
    expect(to.pathname).toBe('/mcp/authorize')
    expect(to.searchParams.get('client_id')).toBe(ID)
    expect(to.searchParams.get('client_name')).toBeNull()
    expect(to.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(m.fetches).toBe(1)
    expect(m.rowLookups).toBe(0) // never a stored row for a URL client
    expect(m.upserts).toHaveLength(0)
  })

  it('a redirect_uri the document does not list: a 400, no Location', async () => {
    m.user = { id: 'u1' }
    const res = await authorize(authorizeUrl({ client_id: ID, redirect_uri: 'http://127.0.0.1:9999/steal' }))
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect((await res.json()).error).toBe('invalid_redirect_uri')
  })

  it("a document naming another URL (borrowed), or with a secret: invalid_client", async () => {
    m.user = { id: 'u1' }
    for (const doc of [{ ...DOC, client_id: 'https://real-app.example.com/client.json' }, { ...DOC, client_secret: 's' }, { ...DOC, token_endpoint_auth_method: 'client_secret_basic' }]) {
      m.doc = doc
      const res = await authorize(authorizeUrl({ client_id: ID, redirect_uri: CALLBACK }))
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
      expect((await res.json()).error).toBe('invalid_client')
    }
  })
})

describe('loopback callbacks (RFC 8252 §7.3)', () => {
  // Claude Code's own document lists its callbacks with no port: the app
  // takes a free one at sign-in.
  const CLAUDE_CODE = {
    client_id: ID,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
  }
  const consentRedirect = async (redirect_uri: string) => {
    const res = await authorize(authorizeUrl({ client_id: ID, redirect_uri }))
    return res.status === 400 ? null : new URL(res.headers.get('location')!).searchParams.get('redirect_uri')
  }

  it('a portless loopback callback takes the port the app asked for, and the code goes there', async () => {
    m.user = { id: 'u1' }
    m.doc = CLAUDE_CODE
    expect(await consentRedirect('http://localhost:54321/callback')).toBe('http://localhost:54321/callback')
    expect(await consentRedirect('http://127.0.0.1:54321/callback')).toBe('http://127.0.0.1:54321/callback')
    const res = await approve(post('approve', { client_id: ID, redirect_uri: 'http://127.0.0.1:61000/callback', code_challenge: 'c' }))
    expect(new URL((await res.json()).redirect_url).origin).toBe('http://127.0.0.1:61000')
    expect(m.inserts[0]).toMatchObject({ redirect_uri: 'http://127.0.0.1:61000/callback' })
  })

  it('any port, but nothing else: the path, scheme and host are still the listed ones', async () => {
    m.user = { id: 'u1' }
    m.doc = CLAUDE_CODE
    for (const uri of ['http://localhost:54321/other', 'https://localhost:54321/callback', 'http://localhost:54321/callback?x=1', 'http://evil.example:54321/callback', 'http://localhost:54321/callback#f']) {
      expect(await consentRedirect(uri), uri).toBeNull()
    }
  })

  it('a callback listed WITH a port matches only that port', async () => {
    m.user = { id: 'u1' }
    m.doc = { ...DOC, redirect_uris: ['http://127.0.0.1:33418/'] }
    expect(await consentRedirect('http://127.0.0.1:33418/')).toBe('http://127.0.0.1:33418/')
    expect(await consentRedirect('http://127.0.0.1:40000/')).toBeNull()
  })
})

describe('POST /api/mcp/oauth/approve, an https client_id', () => {
  const body = { client_id: ID, redirect_uri: CALLBACK, code_challenge: 'c', code_challenge_method: 'S256', scope: 'read', state: 's' }

  it('saves the client from the document, then mints the code bound to it', async () => {
    m.user = { id: 'u1' }
    const res = await approve(post('approve', body))
    expect(res.status).toBe(200)
    expect(m.order).toEqual(['upsert:mcp_oauth_client', 'insert:mcp_auth_code'])
    expect(m.upserts[0]).toEqual({
      client_id: ID,
      client_name: 'Example App',
      redirect_uris: DOC.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    })
    expect(m.inserts[0]).toMatchObject({ client_id: ID, redirect_uri: CALLBACK, user_id: 'u1' })
    const to = new URL((await res.json()).redirect_url)
    expect(to.origin + to.pathname).toBe(CALLBACK)
  })

  it('checks the document again: a callback it dropped since the consent page opened is refused', async () => {
    m.user = { id: 'u1' }
    m.doc = { ...DOC, redirect_uris: ['https://app.example.com/cb'] }
    const res = await approve(post('approve', body))
    expect(res.status).toBe(400)
    expect(m.order).toEqual([])
  })

  it('no code when the client row could not be saved', async () => {
    m.user = { id: 'u1' }
    m.upsertError = { message: 'boom' }
    const res = await approve(post('approve', body))
    expect(res.status).toBe(500)
    expect(m.inserts).toHaveLength(0)
  })
})

describe('POST /api/mcp/oauth/deny, an https client_id', () => {
  it("back to the document's own callback with access_denied, writing nothing", async () => {
    m.user = { id: 'u1' }
    const res = await deny(post('deny', { client_id: ID, redirect_uri: CALLBACK, state: 's' }))
    const to = new URL((await res.json()).redirect_url)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('state')).toBe('s')
    expect(m.upserts).toHaveLength(0)
  })
})

describe('POST /api/mcp/oauth/client-info (what the consent page shows)', () => {
  it("the document's own name and the host that published it, whatever the page's URL says", async () => {
    m.user = { id: 'u1' }
    const res = await clientInfo(post('client-info', { client_id: ID, redirect_uri: CALLBACK, client_name: 'Claude Code (verified)' }))
    expect(await res.json()).toEqual({ client_name: 'Example App', publisher_host: 'app.example.com', publisher_path: '/oauth/client.json', redirect_uri: CALLBACK })
  })

  it('a registered client: its stored name cleaned, no publisher', async () => {
    m.user = { id: 'u1' }
    m.row = { client_id: 'mcp_abc', redirect_uris: ['https://client.example/cb'], client_name: 'Claude\u202e edoC' }
    const res = await clientInfo(post('client-info', { client_id: 'mcp_abc', redirect_uri: 'https://client.example/cb' }))
    expect(await res.json()).toEqual({ client_name: 'Claude edoC', publisher_host: null, publisher_path: null, redirect_uri: 'https://client.example/cb' })
  })

  it('signed out: 401, nothing fetched; an unlisted callback: 400', async () => {
    expect((await clientInfo(post('client-info', { client_id: ID, redirect_uri: CALLBACK }))).status).toBe(401)
    expect(m.fetches).toBe(0)
    m.user = { id: 'u1' }
    expect((await clientInfo(post('client-info', { client_id: ID, redirect_uri: 'http://127.0.0.1:1/x' }))).status).toBe(400)
  })
})

describe('the real documents (as served 2026-10-22)', () => {
  // Copied from https://claude.ai/oauth/claude-code-client-metadata and
  // https://vscode.dev/oauth/client-metadata.json.
  const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata'
  const CLAUDE_CODE = {
    client_id: CLAUDE_CODE_ID,
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
  const VSCODE_ID = 'https://vscode.dev/oauth/client-metadata.json'
  const VSCODE = {
    client_name: 'Visual Studio Code',
    logo_uri: 'https://code.visualstudio.com/assets/branding/code-stable.png',
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    client_id: VSCODE_ID,
    client_uri: 'https://vscode.dev/product',
    redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
  }
  const consent = async (client_id: string, redirect_uri: string) => {
    const res = await authorize(authorizeUrl({ client_id, redirect_uri }))
    return res.status === 400 ? null : new URL(res.headers.get('location')!).searchParams.get('redirect_uri')
  }

  it('Claude Code: its callback on whatever port it picked', async () => {
    m.user = { id: 'u1' }
    m.doc = CLAUDE_CODE
    expect(await consent(CLAUDE_CODE_ID, 'http://localhost:45123/callback')).toBe('http://localhost:45123/callback')
    expect(await consent(CLAUDE_CODE_ID, 'http://127.0.0.1:45123/callback')).toBe('http://127.0.0.1:45123/callback')
  })

  it('VS Code: its fixed loopback port, and its web redirect', async () => {
    m.user = { id: 'u1' }
    m.doc = VSCODE
    expect(await consent(VSCODE_ID, 'http://127.0.0.1:33418/')).toBe('http://127.0.0.1:33418/')
    expect(await consent(VSCODE_ID, 'https://vscode.dev/redirect')).toBe('https://vscode.dev/redirect')
    expect(await consent(VSCODE_ID, 'http://127.0.0.1:40000/')).toBeNull()
  })
})

describe('scopes: only read and write, never an empty grant', () => {
  it('authorize drops unknown words and refuses a request for none it knows (an empty list reads as full access)', async () => {
    m.user = { id: 'u1' }
    const consentScope = async (scope: string) => {
      const res = await authorize(authorizeUrl({ client_id: ID, redirect_uri: CALLBACK, scope }))
      return res.status === 400 ? (await res.json()).error : new URL(res.headers.get('location')!).searchParams.get('scope')
    }
    expect(await consentScope('read')).toBe('read')
    expect(await consentScope('write')).toBe('read write') // write reads too (isReadOnlyToken): the page must say so
    expect(await consentScope('read write Verified\u00a0by\u00a0Anthropic')).toBe('read write')
    expect(await consentScope('admin')).toBe('invalid_scope')
    expect(await consentScope('Verified by Anthropic')).toBe('invalid_scope')
  })

  it('approve keeps the same rule: the consent page query is anyone to write', async () => {
    m.user = { id: 'u1' }
    const body = { client_id: ID, redirect_uri: CALLBACK, code_challenge: 'c' }
    expect((await approve(post('approve', { ...body, scope: 'admin' }))).status).toBe(400)
    expect(m.order).toEqual([]) // refused before the client row is saved, not just before the code
    expect(m.fetches).toBe(0)
    await approve(post('approve', { ...body, scope: 'read sudo' }))
    expect(m.inserts[0]).toMatchObject({ scopes: ['read'] })
    await approve(post('approve', { ...body, scope: 'write' }))
    expect(m.inserts[1]).toMatchObject({ scopes: ['read', 'write'] })
  })
})

describe('authorization server metadata', () => {
  it('says client metadata documents are supported, beside registration', async () => {
    const meta = await (await serverMetadata()).json()
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.registration_endpoint).toBe('https://dial8.ai/api/mcp/oauth/register')
  })
})
