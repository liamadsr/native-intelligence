/**
 * Network-policy mapping tests for the coding-agent sandbox.
 *
 * The invariants under test (only `trusted` opens egress):
 *   1. 'restricted' → EXACTLY RESTRICTED_ALLOW_HOSTS (the single source of
 *      truth, pinned to its exact contents below) plus the app's git gate
 *      host, and NO "*" catch-all (all other egress denied);
 *   2. 'trusted' → allow-all egress via a "*" catch-all;
 *   3. 'isolated' and any unknown value → github.com and the git gate ONLY;
 *      (1-3: the hosts of every tier are pinned exactly);
 *   4. NO GITHUB CREDENTIAL: no rule in any tier carries a GitHub token (the
 *      sandbox has none: the git gate adds it server-side). github.com is
 *      allowed with no rule at all, so a clone, fetch or push straight to
 *      GitHub goes out anonymous, the live branch included;
 *   5. the run's git gate token rides exactly the gate's six endpoints (reads
 *      and pushes, each with its method), and nothing else rides along (no
 *      Vercel protection-bypass secret);
 *   6. off the hosted sandbox (broker null) no rule carries any credential.
 */
import { describe, it, expect } from 'vitest'
import {
  buildNetworkPolicy,
  gitGateRules,
  RESTRICTED_ALLOW_HOSTS,
  sanitizeEnvVars,
  type GitEgress,
} from '../../sandbox'

const GATE_TOKEN = 'gate.tokenexample'
const GATE_URL = 'https://app-abc123.vercel.app/api/internal/agent-run/git'
const GATE_HOST = 'app-abc123.vercel.app'
const basic = (t: string) => 'Basic ' + Buffer.from(`x-access-token:${t}`, 'utf8').toString('base64')
const GATE_BASIC = basic(GATE_TOKEN)

const BROKERED: GitEgress = { gateUrl: GATE_URL, broker: { gateToken: GATE_TOKEN } }
const LOCAL: GitEgress = { gateUrl: 'http://localhost:3000/api/internal/agent-run/git', broker: null }

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
 * Would the firewall put `credential` (null: ANY credential) on this request?
 * A rule applies when every dimension it names matches. The path is tried raw
 * AND percent-decoded (whichever the firewall matches on): an endpoint must
 * match, anything else must match neither way.
 */
function credentialOn(
  rules: Rule[],
  credential: string | null,
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
      const carries = credential === null
        ? (r.transform ?? []).some((t) => Object.keys(t.headers ?? {}).length > 0)
        : r.transform?.some((t) => t.headers?.authorization === credential)
      if (!carries) return false
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
const gateTokenOn = (rules: Rule[], req: { method: string; path: string; query?: Record<string, string> }) =>
  credentialOn(rules, GATE_BASIC, req)

/** The six gate endpoints, as git and git-lfs call them. */
const GATE_ENDPOINTS = [
  { method: 'GET', path: '/api/internal/agent-run/git/info/refs', query: { service: 'git-upload-pack' } },
  { method: 'GET', path: '/api/internal/agent-run/git/info/refs', query: { service: 'git-receive-pack' } },
  { method: 'POST', path: '/api/internal/agent-run/git/git-upload-pack' },
  { method: 'POST', path: '/api/internal/agent-run/git/git-receive-pack' },
  { method: 'POST', path: '/api/internal/agent-run/git/info/lfs/objects/batch' },
  { method: 'POST', path: '/api/internal/agent-run/git/info/lfs/locks/verify' },
]

/** Every tier's hosts, exactly (the gate host is added per run). */
const TIER_HOSTS: Record<string, string[]> = {
  trusted: ['*', GATE_HOST, 'github.com'],
  restricted: [...RESTRICTED_ALLOW_HOSTS, GATE_HOST],
  isolated: [GATE_HOST, 'github.com'],
  'something-new': [GATE_HOST, 'github.com'],
}

describe('buildNetworkPolicy', () => {
  it('RESTRICTED_ALLOW_HOSTS is exactly GitHub + npm (the git gate host is added per run)', () => {
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

  it.each(Object.entries(TIER_HOSTS))('%s → exactly its hosts, brokered or not', (networkAccess, hosts) => {
    for (const egress of [BROKERED, { ...LOCAL, gateUrl: GATE_URL }]) {
      const allow = asRecord(buildNetworkPolicy(networkAccess as never, egress))
      expect(Object.keys(allow).sort()).toEqual([...hosts].sort())
    }
  })

  it("restricted → no '*' catch-all, and npm with no rule", () => {
    const allow = asRecord(buildNetworkPolicy('restricted', BROKERED))
    expect(Object.keys(allow)).not.toContain('*')
    expect(allow['registry.npmjs.org']).toEqual([])
  })

  it("trusted → allow-all via '*' catch-all, with the gate's rules on the gate host", () => {
    const allow = asRecord(buildNetworkPolicy('trusted', BROKERED))
    expect(allow['*']).toEqual([])
    expect(allow[GATE_HOST][0].transform?.[0].headers?.authorization).toBe(GATE_BASIC)
  })

  describe.each(['trusted', 'restricted', 'isolated', 'something-new'] as const)('%s: no GitHub credential, the gate token on the gate only', (networkAccess) => {
    const allow = asRecord(buildNetworkPolicy(networkAccess as never, BROKERED))

    it('no host but the gate host has any rule: github.com and the rest carry nothing', () => {
      for (const [host, hostRules] of Object.entries(allow)) {
        if (host !== GATE_HOST) expect(hostRules).toEqual([])
      }
    })

    it.each([
      { method: 'GET', path: '/acme/app.git/info/refs', query: { service: 'git-upload-pack' } },
      { method: 'POST', path: '/acme/app.git/git-upload-pack' },
      { method: 'POST', path: '/acme/app.git/info/lfs/objects/batch' },
      { method: 'POST', path: '/acme/app.git/info/lfs/locks/verify' },
      { method: 'POST', path: '/acme/app.git/git-receive-pack' },
      { method: 'GET', path: '/acme/app.git/info/refs', query: { service: 'git-receive-pack' } },
    ])('a request straight to GitHub ($method $path) carries no credential at all', (req) => {
      expect(credentialOn(allow['github.com'], null, req)).toBe(false)
    })

    it('the gate host carries exactly the six gate rules, the authorization header only', () => {
      // Only the authorization header: no protection-bypass secret rides along.
      const rule = (method: string, endpoint: string, service?: string) => ({
        match: {
          method: [method],
          path: { exact: `/api/internal/agent-run/git/${endpoint}` },
          ...(service ? { queryString: [{ key: { exact: 'service' }, value: { exact: service } }] } : {}),
        },
        transform: [{ headers: { authorization: GATE_BASIC } }],
      })
      expect(allow[GATE_HOST]).toEqual([
        rule('GET', 'info/refs', 'git-upload-pack'),
        rule('GET', 'info/refs', 'git-receive-pack'),
        rule('POST', 'git-upload-pack'),
        rule('POST', 'git-receive-pack'),
        rule('POST', 'info/lfs/objects/batch'),
        rule('POST', 'info/lfs/locks/verify'),
      ])
    })

    it.each(GATE_ENDPOINTS)('the gate token rides the gate endpoint $method $path', (req) => {
      expect(gateTokenOn(allow[GATE_HOST], req)).toBe(true)
    })

    it.each([
      { method: 'GET', path: '/api/internal/agent-run/git/info/refs' },
      { method: 'GET', path: '/api/internal/agent-run/git/info/refs', query: { service: 'git-other' } },
      { method: 'POST', path: '/api/internal/agent-run/git/info/refs', query: { service: 'git-upload-pack' } },
      { method: 'GET', path: '/api/internal/agent-run/git/git-receive-pack' },
      { method: 'GET', path: '/api/internal/agent-run/git/git-upload-pack' },
      { method: 'GET', path: '/api/internal/agent-run/git/info/lfs/objects/batch' },
      { method: 'POST', path: '/api/internal/agent-run/git/info/lfs/locks' },
      { method: 'POST', path: '/api/internal/agent-run/git/info/lfs/locks/1/unlock' },
      { method: 'POST', path: '/api/internal/agent-run/git/x' },
      { method: 'GET', path: '/api/internal/agent-run/spec' },
      { method: 'POST', path: '/api/internal/agent-run/outcome' },
      { method: 'POST', path: '/api/internal/agent-run/git/../outcome' },
      { method: 'POST', path: '/api/internal/agent-run/git/git-upload-pack/../../outcome' },
      { method: 'POST', path: '/api/internal/agent-run/git/git-upload-pack%2F..%2F..%2Foutcome' },
      { method: 'POST', path: '/api/internal/agent-run/git/git-upload-pack?/../../outcome' },
      { method: 'POST', path: '/API/internal/agent-run/git/git-upload-pack' },
      { method: 'POST', path: '//api/internal/agent-run/git/git-upload-pack' },
      { method: 'GET', path: '/' },
    ])('the gate token never rides $method $path', (req) => {
      expect(gateTokenOn(allow[GATE_HOST], req)).toBe(false)
    })

    it('every gate rule is an exact path with one method (never a prefix or pattern another path could share)', () => {
      expect(allow[GATE_HOST]).toHaveLength(6)
      for (const rule of allow[GATE_HOST]) {
        expect(rule.match?.path?.exact).toMatch(/^\/api\/internal\/agent-run\/git\//)
        expect(rule.match?.path?.startsWith).toBeUndefined()
        expect(rule.match?.path?.regex).toBeUndefined()
        expect(rule.match?.method?.length).toBe(1)
      }
    })
  })

  it('off the hosted sandbox (no broker) no rule carries any credential, and the local gate host is still allowed', () => {
    for (const tier of ['trusted', 'restricted', 'isolated'] as const) {
      const allow = asRecord(buildNetworkPolicy(tier, LOCAL))
      expect(allow['github.com']).toEqual([])
      expect(allow['localhost']).toEqual([])
      expect(JSON.stringify(allow)).not.toContain('Basic')
    }
  })

  it('brokers the gate token as Basic x-access-token, never a bare token anywhere', () => {
    const serialized = JSON.stringify(buildNetworkPolicy('restricted', BROKERED))
    expect(serialized).not.toContain(GATE_TOKEN)
    expect(serialized).toContain(GATE_BASIC)
  })

  it('gitGateRules is exactly the six gate requests', () => {
    expect(gitGateRules(GATE_URL, GATE_TOKEN).map((r) => r.match)).toEqual([
      {
        method: ['GET'],
        path: { exact: '/api/internal/agent-run/git/info/refs' },
        queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
      },
      {
        method: ['GET'],
        path: { exact: '/api/internal/agent-run/git/info/refs' },
        queryString: [{ key: { exact: 'service' }, value: { exact: 'git-receive-pack' } }],
      },
      { method: ['POST'], path: { exact: '/api/internal/agent-run/git/git-upload-pack' } },
      { method: ['POST'], path: { exact: '/api/internal/agent-run/git/git-receive-pack' } },
      { method: ['POST'], path: { exact: '/api/internal/agent-run/git/info/lfs/objects/batch' } },
      { method: ['POST'], path: { exact: '/api/internal/agent-run/git/info/lfs/locks/verify' } },
    ])
    // A trailing slash on the gate URL changes nothing.
    expect(gitGateRules(`${GATE_URL}/`, GATE_TOKEN)).toEqual(gitGateRules(GATE_URL, GATE_TOKEN))
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
