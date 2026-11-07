/**
 * Anti-drift lock on the FIVE mirrored agent-side security helpers.
 *
 * ── Why there are five copies ───────────────────────────────────────────────
 * The eve compiler bundles ONLY the agent's own tree (`agents/<name>/*`), so a
 * tool file physically cannot `import` from `src/`. The SSRF url-guard and the
 * per-session web_fetch abuse cap therefore exist once per agent, mirrored by
 * hand. That is a forced duplication, not a design preference — but five hand-
 * copies of a SECURITY predicate is exactly the shape that rots: someone
 * tightens the IPv6 branch in the agent they happen to be editing, the other
 * four keep the old one, and four agents quietly stay exploitable.
 *
 * This test makes that impossible to land silently: it reads all five copies off
 * disk and asserts their CODE is byte-identical after normalization. It is the
 * cheap substitute for the import the bundler won't allow.
 *
 * ── Normalization (precise) ─────────────────────────────────────────────────
 * Only PROSE is allowed to differ — each copy names its own agent ("the
 * work-agent's web_fetch tool", "one run" vs "one chat conversation"). So the
 * comparison strips, in order:
 *   1. every /* … *\/ block comment (non-greedy, DOTALL) — the file headers
 *   2. every whole-line // comment (a line whose first non-space chars are //)
 *   3. all runs of whitespace collapsed to a single space, then trimmed
 * Nothing else is touched: identifiers, string literals, numeric constants and
 * statement order must all match exactly. Trailing `//` comments on a line of
 * CODE are deliberately NOT stripped (a regex that removed them would also eat
 * `//` inside a string literal such as a URL), so keep inline comments on code
 * lines identical across copies — or move them to their own line.
 *
 * NOT covered: src/lib/mcp-client/url-guard.ts. That is a SIBLING, not a copy —
 * it exports assertSafeMcpUrl/ensureSafeMcpUrl (different names, different
 * doc-comments) for the MCP client's own flows. The agent copies were derived
 * from it and the predicates agree today, but pinning them byte-for-byte would
 * force a rename in app code to satisfy an agent test. Keep the two families in
 * sync by hand when the SSRF rules change; this test locks the five that CAN be
 * identical.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Every agent whose tree carries a mirrored copy. */
const AGENTS = [
  'chat-agent',
  'coding-agent',
  'onboarding-researcher',
  'skill-runner',
  'work-agent',
] as const

/** The agents/ root, from this file at agents/chat-agent/lib/__tests__/. */
const AGENTS_ROOT = new URL('../../../', import.meta.url)

function pathFor(agent: string, module: string): string {
  return fileURLToPath(new URL(`${agent}/lib/${module}.ts`, AGENTS_ROOT))
}

/** See the header for the exact contract. Prose out, code in. */
function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // 1. block comments
    .replace(/^[ \t]*\/\/.*$/gm, '') // 2. whole-line // comments
    .replace(/\s+/g, ' ') // 3. collapse whitespace
    .trim()
}

/** Load-bearing code that only survives if the stripping really is comments-only, and a floor on its size. */
const ANCHORS = {
  'url-guard': { anchor: 'export function ensureSafeWebUrl', minLength: 500 },
  'web-fetch-cap': { anchor: 'export function countWebFetch', minLength: 500 },
  // A5: web_fetch's untrusted-content marker (the app twin is src/lib/email/untrusted.ts).
  untrusted: { anchor: 'export function wrapUntrustedWeb', minLength: 300 },
} as const

describe.each(['url-guard', 'web-fetch-cap', 'untrusted'] as const)(
  'agents/*/lib/%s.ts — the five copies have not drifted',
  (module) => {
    const canonicalPath = pathFor('chat-agent', module)
    const canonical = normalize(readFileSync(canonicalPath, 'utf8'))

    it('the chat-agent original is non-trivial (guards against a normalizer that eats everything)', () => {
      // If normalize() ever over-matched and returned '' (or near-''), every
      // comparison below would pass vacuously. Anchor on load-bearing code that
      // only survives if the stripping really is comments-only.
      expect(canonical.length).toBeGreaterThan(ANCHORS[module].minLength)
      expect(canonical).toContain(ANCHORS[module].anchor)
    })

    for (const agent of AGENTS.filter((a) => a !== 'chat-agent')) {
      it(`${agent} matches the chat-agent original (comments aside)`, () => {
        const copy = normalize(readFileSync(pathFor(agent, module), 'utf8'))
        // A failure here means a security predicate was changed in ONE agent.
        // Fix by propagating the change to all five, not by relaxing this test.
        expect(copy).toBe(canonical)
      })
    }
  },
)
