# Testing guide

This doc describes how tests are organized in this repo, what patterns to
follow, and how to run the suite. It's meant to be the first thing you read
before adding new tests.

## Running tests

```bash
npm test              # Run full suite once (what `npm run build` runs first)
npm run test:watch    # Watch mode during development
npm run test:coverage # v8 coverage report in ./coverage/
npm run typecheck     # Standalone tsc --noEmit
npm run lint          # ESLint on src/ (next lint was removed in Next 16)
```

`npm run build` runs `vitest run` first — if any test fails, the build is
blocked.

Nothing else runs the suite. No GitHub workflow does (the `Image` workflow only
builds the image and smoke-tests it), and production's image build leaves it out
(`deploy/app/Dockerfile`), so a roll-out can ship with failing tests. The gate is
the run on your own machine: run the full suite on Node 24 before you push.

## File layout

- Test files live next to the code they cover, under `__tests__/`:
  ```
  src/lib/api-auth.ts
  src/lib/__tests__/api-auth.test.ts
  ```
- Shared helpers live under `src/test/`:
  - `setup.ts` — global test setup (loaded via `vitest.config.ts`)
  - `supabase-mock.ts` — chainable Supabase client mock
  - `next-mocks.ts` — mocks for `next/headers` cookies+headers

Vitest is configured via `vitest.config.ts`. The test environment is `node`
(we're mostly testing server-side logic). Switch to `happy-dom` or `jsdom`
when we start adding React component tests.

## What to test

Priority order, from most to least valuable:

1. **Security-critical paths.** Anything that decides auth, workspace
   membership, or plan gating. See `src/lib/ai/__tests__/auth.test.ts`
   and `src/lib/__tests__/workspace.test.ts`.
2. **Pure logic with branches.** Parsing, formatting, filtering,
   LRU/eviction, cost extraction. These are cheap to test and catch
   regressions fast. See `src/lib/__tests__/capture-cache.test.ts`.
3. **Shared helpers used by many files.** `api-auth`, `api-errors`,
   `stripe`. Breaking these breaks 100+ callers — a test here is worth
   100 tests at the call sites.
4. **Route handlers with tricky branches.** E.g. webhook paths that must
   always return 200, or routes with error-shape guarantees. See
   `src/lib/email/__tests__/gmail-webhook.test.ts`.

What we **don't** test: trivial pass-through handlers, Next.js page/layout
files (they're excluded from coverage in `vitest.config.ts`).

## Patterns

### Mocking Supabase

Prefer the hoisted-mock pattern for fine-grained control. This is the
shape the existing tests use and what `api-auth.test.ts` demonstrates:

```ts
const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  tableResult: { data: null, error: null } as { data: unknown; error: unknown },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => hoisted.tableResult,
        }),
      }),
    }),
  }),
}))

const { myHelper } = await import('@/lib/my-helper')

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.tableResult = { data: null, error: null }
})
```

For simpler cases, use the chain builder in `src/test/supabase-mock.ts`
— it accepts any chained method call and resolves to whatever result
you provide.

### Testing API route handlers

Mock dependencies at the module level, then `await import()` the route.

```ts
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: vi.fn(),
}))

const { POST } = await import('@/app/api/account/actions/route')

// Build a fetch-like Request:
const req = new Request('https://nativeintelligence.dev/api/account/actions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Test' }),
})
```

### Testing Response objects

Because our helpers return `NextResponse` (a standard `Response` subclass),
you can just `await res.json()` and assert on the body:

```ts
const res = await POST(req)
expect(res.status).toBe(400)
expect(await res.json()).toEqual({
  error: 'Title is required',
  code: 'BAD_REQUEST',
})
```

### Components that fetch: answer at once

A jsdom suite that renders an app component usually also loads
`src/lib/workspace-fetch.ts`, which replaces `window.fetch`. For an `/api/` URL
the replacement reads a token through the Supabase client before it sends, so
an unmocked request fails late: possibly after its test, or after the file's
jsdom is gone. If a state update runs then, it throws "window is not defined" and
fails the run although every test passed (the Image workflow's Tests job did
exactly this on 2026-11-10).

Give such a suite `stubAppFetch` from `src/test/app-fetch-stub.ts`: it answers
the paths you list with a JSON body at once and refuses everything else at once.

```ts
beforeEach(() => {
  stubAppFetch({ '/api/account/prospecting/entries/*': {} }) // or stubAppFetch() to refuse all
  // ...create the root and render
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
```

### Source-scan guards (tripwires)

Some invariants are textual, and a behavioral test would have to boot the whole server
import graph to check them. Those invariants get a test that reads the SOURCE and asserts a
pattern is absent. Examples:
`src/app/api/ai/live-agent/__tests__/no-act-literal.test.ts` (no hardcoded gate mode) and
`src/lib/ai/__tests__/eve-everywhere-tripwire.test.ts` (no in-process model call: no AI SDK
model entry point, no value import from `'ai'` outside a no-model-call allow-set, no eve
in-process model module (`eve/ai`, `eve/models/*`, `eve/evals`, `eve/tools/agent-router`,
`auto` from `eve/tools/approval`) and no unclassified eve subpath, no provider package outside
its allowlist, and no `*_EVE_RUNTIME` flag). Follow
their shape:

- Assert the walk found the files it polices. An empty glob makes every other assertion
  vacuously true.
- Match code, not text. Ported code legitimately explains what it replaced in comments. The
  eve tripwire parses each file with the TypeScript compiler (`ts.createSourceFile`) and reads
  identifiers and import specifiers from the AST, so comments, strings, regexes and JSX text
  can never read as code. A hand-rolled lexer can be derailed by one stray backtick. Also
  assert every scanned file parses without a syntax error.
- Keep any allowlist in the test with a reason per entry, pinned to exactly what it is
  exempted for (the eve tripwire pins one generator and an exact call count), plus a staleness
  check that fails when an entry no longer needs its exemption.
- The failure message says what to do instead. For the eve tripwire: move the call onto an
  eve agent (a one-shot generation goes on the `utility` agent).

### Internal secrets in tests

`src/test/setup.ts` scrubs the eve internal secrets (`RUN_SKILL_INTERNAL_SECRET`,
`AGENT_RUN_INTERNAL_SECRET`, `CHAT_INTERNAL_SECRET`, `UTILITY_INTERNAL_SECRET`,
`LIVE_AGENT_INTERNAL_SECRET`) and the app's other settings. `npm run build` runs the suite
first, in a shell that may hold the real values, and an unscrubbed secret
lets a test mint real tokens and make live calls. A test that needs a secret sets it
with `vi.stubEnv`. There are no eve runtime flags to set: eve is the only runtime.

### Chat skill evals: the changed skills, and flywheel cases

The static skill evals run in every build. The live ones are opt-in, DEV only, and cost one paid chat turn per case (see `docs/evaluations/chat-skills/README.md`). To run only the cases a branch touches:

```bash
npx tsx scripts/skill-evals-changed.ts                 # print CHAT_SKILL_EVAL_ONLY for HEAD vs origin/main
npx tsx scripts/skill-evals-changed.ts --base main --run   # and run the live evals for exactly those
```

A changed `cases/<slug>.ts` selects that skill. So does a migration whose changed lines name a skill that has cases. A change to the chat agent's instructions, the skills loader, the packs or the judge selects `instructions`. That is a core subset: the first 2 cases of every skill, plus the flywheel's `instructions` cases. You can also set `CHAT_SKILL_EVAL_ONLY=instructions` yourself.

Cases promoted in `/admin/evals` live in `src/lib/packs/skill-evals/cases/flywheel.json`. To import an export:

```bash
npx tsx scripts/eval-flywheel-import.ts ~/Downloads/flywheel-export.json
NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/lib/packs/skill-evals
```

The import validates every entry and refuses the whole file if any entry is bad. It skips candidates already imported. The static test then checks each case's tools, params and skills against the code. Fix or drop a case it flags before you commit.

### Migrations checked against the live schema

A migration test (`src/lib/workspace-merge/__tests__/migration-40*.test.ts` and similar) pins the SQL's text; it cannot run it. A migration that rewrites data is also run against DEV's real schema before it is applied: a fixture-building script, the migration prepended, assertions at the end, and a closing `RAISE EXCEPTION` carrying the verdict so the whole file rolls back. `scripts/merge-workspaces/README.md` is the worked example (the merge engine's end-to-end, `e2e_body.sql`, and its read-only probes), including how to run SQL on a project with the Supabase CLI.

### Avoid

- **Setting globals in the shared setup file.** `src/test/setup.ts`
  deliberately does NOT call `vi.unstubAllGlobals()` in a `beforeEach`,
  because several tests depend on module-level `vi.stubGlobal('fetch', ...)`
  persisting across tests in the same file. If a test needs fresh globals,
  it should reset them itself.
- **Integration tests that hit real Supabase.** The unit tests should
  fully mock the Supabase client. Real-DB integration tests belong in
  a separate suite (not yet set up — future work).
- **Snapshot tests for API JSON.** They drift and nobody reads the diffs.
  Assert on specific fields instead.

## Adding a test

1. Create `src/<module-path>/__tests__/<filename>.test.ts`.
2. Import the system under test (SUT) via `@/` path alias.
3. Mock external dependencies with `vi.mock`, using `vi.hoisted` if you
   need to reference the mock state from both the factory and the test body.
4. Run `npm test` and make sure nothing else breaks.
5. Commit with a message that explains what behavior the test locks in.
