/**
 * Network-policy mapping tests for the coding-agent sandbox.
 *
 * The invariants under test (only `trusted` opens egress):
 *   1. 'restricted' → EXACTLY RESTRICTED_ALLOW_HOSTS (the single source of
 *      truth, pinned to its exact contents below) plus the app's push gate
 *      host, and NO "*" catch-all (all other egress denied);
 *   2. 'trusted' → allow-all egress via a "*" catch-all;
 *   3. 'isolated' and any unknown value → github.com and the push gate ONLY;
 *   4. THE PUSH HOLE: the GitHub token rides only git's READ requests for this
 *      repo (exact paths + methods + the upload-pack service). No rule ever
 *      puts it on git-receive-pack, so the sandbox can't push to GitHub, the
 *      live branch included. Pushes authenticate only at the push gate's two
 *      exact endpoints, with the run's push token, and nothing else rides
 *      along (no Vercel protection-bypass secret);
 *   5. off Vercel (broker null) no rule carries any credential.
 */
import { describe, it, expect } from 'vitest'
import {
  buildNetworkPolicy,
  githubReadRules,
  repoGitPathPrefix,
  RESTRICTED_ALLOW_HOSTS,
  sanitizeEnvVars,
  type GitEgress,
} from '../../sandbox'

const TOKEN = 'gho_exampletoken1234567890'
const PUSH_TOKEN = 'push.tokenexample'
const REPO = 'acme/app'
const PUSH_URL = 'https://app-abc123.vercel.app/api/internal/agent-run/git'
const basic = (t: string) => 'Basic ' + Buffer.from(`x-access-token:${t}`, 'utf8').toString('base64')
const EXPECTED_BASIC = basic(TOKEN)
const PUSH_BASIC = basic(PUSH_TOKEN)

const BROKERED: GitEgress = { repoFullName: REPO, pushUrl: PUSH_URL, broker: { githubToken: TOKEN, pushToken: PUSH_TOKEN } }
const LOCAL: GitEgress = { repoFullName: REPO, pushUrl: 'http://localhost:3000/api/internal/agent-run/git', broker: null }

type Matcher = { exact?: string; startsWith?: string; regex?: string }
type Rule = {
  match?: { path?: Matcher; method?: string[]; queryString?: Array<{ key?: Matcher; value?: Matcher }> }
  transform?: Array<{ headers?: Record<string, string> }>
}

const matches = (m: Matcher | undefined, v: string) =>
  !m ||
  ((m.exact === undefined || m.exact === v) &&
    (m.startsWith === undefined || v.startsWith(m.startsWith)) &&
    (m.regex === undefined || new RegExp(m.regex).test(v)))

/** Narrow the union to the object (allow-list / record) form for assertions. */
function asRecord(policy: ReturnType<typeof buildNetworkPolicy>) {
  if (typeof policy === 'string') throw new Error(`expected an object policy, got "${policy}"`)
  const allow = policy.allow
  if (!allow || Array.isArray(allow)) throw new Error('expected a record-form allow map')
  return allow as Record<string, Rule[]>
}

/**
 * Would the firewall put `credential` on this request? A rule applies when
 * every dimension it names matches. The path is tried raw AND percent-decoded
 * (whichever the firewall matches on): a read must match, a push must match
 * neither way.
 */
function credentialOn(
  rules: Rule[],
  credential: string,
  req: { method: string; path: string; query?: Record<string, string> },
): boolean {
  let decoded = req.path
  try {
    decoded = decodeURIComponent(req.path)
  } catch {
    // keep raw
  }
  const query = Object.entries(req.query ?? {})
  return [req.path, decoded].some((path) =>
    rules.some((r) => {
      if (!r.transform?.some((t) => t.headers?.authorization === credential)) return false
      const m = r.match
      if (!m) return true
      if (m.method && !m.method.includes(req.method)) return false
      if (!matches(m.path, path)) return false
      for (const q of m.queryString ?? []) {
        if (!query.some(([k, v]) => matches(q.key, k) && matches(q.value, v))) return false
      }
      return true
    }),
  )
}
const githubTokenOn = (rules: Rule[], req: { method: string; path: string; query?: Record<string, string> }) =>
  credentialOn(rules, EXPECTED_BASIC, req)

describe('buildNetworkPolicy', () => {
  it('RESTRICTED_ALLOW_HOSTS is exactly GitHub + npm (the push gate host is added per run)', () => {
    // The single source of truth for `restricted` egress (the Settings ▸
    // Environments helper text promises exactly this). Widening it is a
    // deliberate, reviewed change — update the helper text in the same change.
    expect([...RESTRICTED_ALLOW_HOSTS]).toEqual([
      'github.com',
      'api.github.com',
      '*.githubusercontent.com',
      'codeload.github.com',
      'registry.npmjs.org',
    ])
  })

  it("restricted → exactly RESTRICTED_ALLOW_HOSTS + the push gate's host, no '*' catch-all", () => {
    const allow = asRecord(buildNetworkPolicy('restricted', BROKERED))
    expect(Object.keys(allow).sort()).toEqual([...RESTRICTED_ALLOW_HOSTS, 'app-abc123.vercel.app'].sort())
    expect(Object.keys(allow)).not.toContain('*')
    expect(allow['registry.npmjs.org']).toEqual([])
  })

  it("trusted → allow-all via '*' catch-all, with the GitHub and push gate rules", () => {
    const allow = asRecord(buildNetworkPolicy('trusted', BROKERED))
    expect(allow['*']).toEqual([])
    expect(githubTokenOn(allow['github.com'], { method: 'POST', path: '/acme/app.git/git-upload-pack' })).toBe(true)
    expect(allow['app-abc123.vercel.app'][0].transform?.[0].headers?.authorization).toBe(PUSH_BASIC)
  })

  it.each(['isolated', 'something-new'])("%s → github.com and the push gate ONLY: no '*', no npm, no api.github.com", (networkAccess) => {
    const allow = asRecord(buildNetworkPolicy(networkAccess as never, BROKERED))
    expect(Object.keys(allow).sort()).toEqual(['app-abc123.vercel.app', 'github.com'])
  })

  describe.each(['trusted', 'restricted', 'isolated'] as const)('%s: the GitHub token is read-only', (networkAccess) => {
    const allow = asRecord(buildNetworkPolicy(networkAccess, BROKERED))
    const gh = allow['github.com']

    it.each([
      { method: 'GET', path: '/acme/app.git/info/refs', query: { service: 'git-upload-pack' } },
      { method: 'POST', path: '/acme/app.git/git-upload-pack' },
      { method: 'POST', path: '/acme/app.git/info/lfs/objects/batch' },
      { method: 'POST', path: '/acme/app.git/info/lfs/locks/verify' },
    ])('rides the clone/fetch request $method $path', (req) => {
      expect(githubTokenOn(gh, req)).toBe(true)
    })

    it.each([
      { method: 'POST', path: '/acme/app.git/git-receive-pack' },
      { method: 'GET', path: '/acme/app.git/info/refs', query: { service: 'git-receive-pack' } },
      { method: 'GET', path: '/acme/app.git/info/refs' },
      { method: 'POST', path: '/acme/app.git/info/refs', query: { service: 'git-upload-pack' } },
      { method: 'POST', path: '/acme/app.git/git-upload-pack%3F/../git-receive-pack' },
      { method: 'POST', path: '/acme/app.git/git-upload-pack?/../git-receive-pack' },
      { method: 'POST', path: '/acme/app.git/git-upload-pack/../git-receive-pack' },
      { method: 'POST', path: '/acme/app.git/info/refs/../../git-receive-pack' },
      { method: 'POST', path: '/acme/app.git/./git-receive-pack' },
      { method: 'POST', path: '/acme/app.git/git-upload-pack%2F..%2Fgit-receive-pack' },
      { method: 'POST', path: '/acme/app.git/git-upload-pack/x' },
      { method: 'GET', path: '/acme/app.git/git-upload-pack' },
      { method: 'POST', path: '/ACME/app.git/git-receive-pack' },
      { method: 'POST', path: '//acme/app.git/git-receive-pack' },
      { method: 'POST', path: '/x/acme/app.git/git-upload-pack' },
      { method: 'POST', path: '/acme/app-secrets.git/git-upload-pack' },
      { method: 'POST', path: '/other/app.git/git-upload-pack' },
      { method: 'POST', path: '/acme/app.git/info/lfs/locks' },
      { method: 'GET', path: '/acme/app.git/info/lfs/locks/verify' },
      { method: 'POST', path: '/acme/app.git/info/lfs/locks/1/unlock' },
      { method: 'POST', path: '/acme/app.git/info/lfs/locks/verify/../../../git-receive-pack' },
    ])('never rides $method $path (a push or another repo goes out anonymous)', (req) => {
      expect(githubTokenOn(gh, req)).toBe(false)
    })

    it('every GitHub rule is an exact path with a method (never a prefix or pattern a push path could share)', () => {
      expect(gh).toHaveLength(4)
      for (const rule of gh) {
        expect(rule.match?.path?.exact).toMatch(/^\/acme\/app\.git\//)
        expect(rule.match?.path?.exact).not.toContain('receive-pack')
        expect(rule.match?.path?.startsWith).toBeUndefined()
        expect(rule.match?.path?.regex).toBeUndefined()
        expect(rule.match?.method?.length).toBe(1)
      }
    })

    it('no other host carries the GitHub token; the push gate host carries only the push token', () => {
      for (const [host, hostRules] of Object.entries(allow)) {
        if (host !== 'github.com') expect(JSON.stringify(hostRules)).not.toContain(EXPECTED_BASIC)
      }
      const push = allow['app-abc123.vercel.app']
      // Only the authorization header: no protection-bypass secret rides along.
      expect(push).toEqual([
        {
          match: {
            method: ['GET'],
            path: { exact: '/api/internal/agent-run/git/info/refs' },
            queryString: [{ key: { exact: 'service' }, value: { exact: 'git-receive-pack' } }],
          },
          transform: [{ headers: { authorization: PUSH_BASIC } }],
        },
        {
          match: { method: ['POST'], path: { exact: '/api/internal/agent-run/git/git-receive-pack' } },
          transform: [{ headers: { authorization: PUSH_BASIC } }],
        },
      ])
    })

    it.each([
      { method: 'GET', path: '/api/internal/agent-run/git/info/refs', query: { service: 'git-receive-pack' } },
      { method: 'POST', path: '/api/internal/agent-run/git/git-receive-pack' },
    ])('the push token rides the gate endpoint $method $path', (req) => {
      expect(credentialOn(allow['app-abc123.vercel.app'], PUSH_BASIC, req)).toBe(true)
    })

    it.each([
      { method: 'GET', path: '/api/internal/agent-run/git/info/refs', query: { service: 'git-upload-pack' } },
      { method: 'GET', path: '/api/internal/agent-run/git/git-receive-pack' },
      { method: 'POST', path: '/api/internal/agent-run/git/x' },
      { method: 'GET', path: '/api/internal/agent-run/spec' },
      { method: 'POST', path: '/api/internal/agent-run/git/../outcome' },
      { method: 'GET', path: '/' },
    ])('the push token never rides $method $path', (req) => {
      expect(credentialOn(allow['app-abc123.vercel.app'], PUSH_BASIC, req)).toBe(false)
    })
  })

  it('off Vercel (no broker) no rule carries any credential, and the local push host is still allowed', () => {
    for (const tier of ['trusted', 'restricted', 'isolated'] as const) {
      const allow = asRecord(buildNetworkPolicy(tier, LOCAL))
      expect(allow['github.com']).toEqual([])
      expect(allow['localhost']).toEqual([])
      expect(JSON.stringify(allow)).not.toContain('Basic')
    }
  })

  it('brokers the token as Basic x-access-token, never a bare token anywhere', () => {
    const serialized = JSON.stringify(buildNetworkPolicy('restricted', BROKERED))
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).toContain(EXPECTED_BASIC)
  })

  it('githubReadRules is exactly the four read requests', () => {
    expect(githubReadRules(TOKEN, REPO).map((r) => r.match)).toEqual([
      {
        method: ['GET'],
        path: { exact: '/acme/app.git/info/refs' },
        queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
      },
      { method: ['POST'], path: { exact: '/acme/app.git/git-upload-pack' } },
      { method: ['POST'], path: { exact: '/acme/app.git/info/lfs/objects/batch' } },
      { method: ['POST'], path: { exact: '/acme/app.git/info/lfs/locks/verify' } },
    ])
  })
})

describe('repoGitPathPrefix', () => {
  // git's smart-HTTP requests for the clone URL https://github.com/acme/app.git
  const prefix = repoGitPathPrefix(REPO)
  it.each([
    '/acme/app.git/info/refs',
    '/acme/app.git/git-upload-pack',
    '/acme/app.git/info/lfs/objects/batch',
  ])('matches %s', (path) => {
    expect(path.startsWith(prefix)).toBe(true)
  })
  it.each([
    '/acme/app-secrets.git/info/refs',
    '/acme/app.gitx/info/refs',
    '/acme/other.git/git-upload-pack',
    '/acme/app/archive/main.zip',
  ])('does not match %s', (path) => {
    expect(path.startsWith(prefix)).toBe(false)
  })
})

describe('sanitizeEnvVars', () => {
  it('keeps ordinary config vars', () => {
    expect(sanitizeEnvVars({ NODE_ENV: 'test', API_BASE: 'https://x' })).toEqual({
      NODE_ENV: 'test',
      API_BASE: 'https://x',
    })
  })

  it('strips reserved/dangerous names (proxy, TLS-bypass, token) case-insensitively', () => {
    const out = sanitizeEnvVars({
      KEEP: '1',
      HTTPS_PROXY: 'http://evil',
      https_proxy: 'http://evil2',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      GH_TOKEN: 'leak',
      github_token: 'leak2',
      NODE_OPTIONS: '--inspect',
    })
    expect(out).toEqual({ KEEP: '1' })
  })

  it('returns an empty object for empty input', () => {
    expect(sanitizeEnvVars({})).toEqual({})
  })
})
