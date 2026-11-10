/**
 * The Codex adapter on fixtures of `codex exec --json` output, in the event
 * shapes OpenAI documents (thread.started, turn.*, item.*; the example lines
 * on developers.openai.com/codex/noninteractive), plus the real `exec --help`
 * of the 0.34.0 installed on this Mac (too old: the probe must refuse it).
 * No CLI runs here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterContext, CliOutput, ProbeRunner } from '../lib/adapter'
import { CODEX_TOKEN_ENV, codexAdapter, codexArgs, codexFeatureArgs, createCodexNormalizer, parseFeatureList } from '../lib/codex'
import { WORKER_INSTRUCTIONS } from '../lib/instructions'

const FIXTURES = join(__dirname, 'fixtures')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const run = (name: string): CliOutput[] => {
  const normalize = createCodexNormalizer()
  return fixture(name)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => normalize(l))
}
const events = (out: CliOutput[]) => out.flatMap((o) => (o.kind === 'event' ? [o.event] : []))

const ctx: AdapterContext = {
  launch: { worker: 'codex', bin: '/b/codex.js', binPath: '/b/codex', jobId: 'job1', folder: '/Users/p/app', mode: 'edit', toolPath: '/usr/bin', extraRead: '/Users/p/repo/.git', home: '/Users/p', tmpdir: '/t', lang: 'en_US.UTF-8' },
  mcp: { url: 'http://127.0.0.1:4100/mcp', token: 'secret-bearer' },
  cliTmp: '/private/tmp/dial8-cli-x',
  cliCwd: '/Users/p/Library/job1/cli',
}

describe('a whole turn', () => {
  it('maps the thread, tool calls, results, messages and the manager calls', () => {
    const out = run('codex-turn.jsonl')
    expect(out.some((o) => o.kind === 'violation')).toBe(false)
    expect(out[0]).toEqual({ kind: 'session', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' })
    expect(events(out)).toEqual([
      { kind: 'report', text: 'Reading the README.' },
      { kind: 'tool', callId: 'item_2', name: 'bash', input: '{"command":"cat README.md"}' },
      { kind: 'tool_result', callId: 'item_2', name: 'bash', ok: true, output: JSON.stringify('exit code: 0\n# Demo') },
      { kind: 'tool', callId: 'item_3', name: 'write_file', input: '{"path":"NOTES.md","content":"x"}' },
      { kind: 'tool_result', callId: 'item_3', name: 'write_file', ok: false, output: JSON.stringify('This folder was granted read-only: NOTES.md cannot be written.') },
      { kind: 'message', text: 'The project is a tiny demo.' },
      { kind: 'finish', summary: 'A tiny demo.' },
    ])
    expect(out.at(-1)).toEqual({ kind: 'turn_end' })
  })

  it('turns a failed login into the sign-in sentence', () => {
    const out = run('codex-auth-failed.jsonl')
    expect(events(out)).toEqual([
      { kind: 'error', message: expect.stringMatching(/isn't signed in.*codex login/) },
      { kind: 'error', message: expect.stringMatching(/isn't signed in/) },
    ])
    expect(out.at(-1)).toEqual({ kind: 'turn_end' })
  })
})

describe('the fence backstop', () => {
  it('stops a Codex that runs a command of its own', () => {
    const out = run('codex-shell.jsonl')
    expect(out.at(-1)).toEqual({ kind: 'violation', message: expect.stringMatching(/ran a command of its own/) })
  })

  it.each([
    [{ type: 'web_search', id: 'i', query: 'x' }, 'item.started', /searched the web/],
    [{ type: 'file_change', id: 'i', changes: [{ path: 'a', kind: 'update' }], status: 'completed' }, 'item.completed', /changed files/],
    [{ type: 'mcp_tool_call', id: 'i', server: 'filesystem', tool: 'read', arguments: {} }, 'item.started', /another MCP server \(filesystem\)/],
  ])('stops %j', (item, type, expected) => {
    expect(createCodexNormalizer()(JSON.stringify({ type, item }))).toEqual([{ kind: 'violation', message: expect.stringMatching(expected) }])
  })

  it.each([
    [{ type: 'collab_tool_call', id: 'i', tool: 'spawn_agent' }, /doesn't know \(collab_tool_call\)/],
    [{ id: 'i' }, /doesn't know \(an item with no type\)/],
  ])('stops an item type it does not know: %j', (item, expected) => {
    expect(createCodexNormalizer()(JSON.stringify({ type: 'item.started', item }))).toEqual([{ kind: 'violation', message: expect.stringMatching(expected) }])
  })

  it('lets reasoning and the todo list through', () => {
    for (const item of [{ type: 'reasoning', id: 'r', text: 'thinking' }, { type: 'todo_list', id: 't', items: [] }]) {
      expect(createCodexNormalizer()(JSON.stringify({ type: 'item.completed', item }))).toEqual([{ kind: 'activity' }])
    }
  })

  it('lets a refused file change through (Codex own sandbox said no)', () => {
    const out = createCodexNormalizer()(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', id: 'i', status: 'failed' } }))
    expect(out).toEqual([{ kind: 'activity' }])
  })

  it('refuses the old JSON format', () => {
    expect(run('codex-legacy.jsonl')).toEqual([{ kind: 'violation', message: expect.stringMatching(/older JSON format/) }])
  })
})

describe('starting a turn', () => {
  const probe = { version: '0.48.0', flags: new Set(['--ignore-rules', '--color']), features: new Set(['shell_tool', 'unified_exec', 'multi_agent', 'hooks', 'rmcp_client', 'personality']) }

  it('ignores the person config, keeps read-only, turns the shell off, and adds only the fence server', () => {
    const args = codexArgs(ctx, probe, { sessionId: null, resume: false })
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    for (const f of ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) expect(args).toContain(f)
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    // Its own empty folder, never the granted one (no AGENTS.md or .codex/ config of anyone's making).
    expect(args[args.indexOf('--cd') + 1]).toBe('/Users/p/Library/job1/cli')
    expect(args).not.toContain('/Users/p/app')
    const overrides = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))
    expect(overrides).toEqual([
      'approval_policy="never"',
      'project_doc_max_bytes=0',
      'web_search="disabled"',
      'tools.view_image=false',
      'features.shell_tool=false',
      'features.unified_exec=false',
      'features.multi_agent=false',
      'features.hooks=false',
      'features.rmcp_client=true',
      'mcp_servers.ni_folder.url="http://127.0.0.1:4100/mcp"',
      `mcp_servers.ni_folder.bearer_token_env_var="${CODEX_TOKEN_ENV}"`,
      'mcp_servers.ni_folder.required=true',
      'mcp_servers.ni_folder.startup_timeout_sec=30',
      'mcp_servers.ni_folder.tool_timeout_sec=660',
      'mcp_servers.ni_folder.default_tools_approval_mode="approve"',
    ])
    expect(args.at(-1)).toBe('-')
    // The bearer travels in the environment, never in the arguments (other processes can read those).
    expect(args.join(' ')).not.toContain('secret-bearer')
    expect(codexAdapter.env(ctx)).toEqual({ [CODEX_TOKEN_ENV]: 'secret-bearer' })
  })

  it('protects its config, instructions, rules and skills', () => {
    const p = codexAdapter.protectedState('/Users/p')
    expect(p.files).toEqual(['*.toml', 'config.json', 'AGENTS.md', 'AGENTS.override.md', 'instructions.md', 'hooks.json', '.env', 'memories*'].map((f) => `/Users/p/.codex/${f}`))
    for (const d of ['rules', 'skills', 'prompts', 'bin', 'plugins', 'automations', 'memories', 'memories_v2']) expect(p.dirs).toContain(`/Users/p/.codex/${d}`)
    expect(p.scriptsUnder).toEqual(['/Users/p/.codex'])
  })

  it('resumes the thread for a later turn', () => {
    const args = codexArgs(ctx, probe, { sessionId: '0199c000-0000-7000-8000-000000000001', resume: true })
    expect(args.slice(-3)).toEqual(['resume', '0199c000-0000-7000-8000-000000000001', '-'])
    for (const bad of ['--last', '-c', 'thr_1', '0199C000-0000-7000-8000-000000000001']) expect(() => codexArgs(ctx, probe, { sessionId: bad, resume: true }), bad).toThrow(/UUID/)
  })

  it('opens the first prompt with the job instructions, and sends later ones as they are', () => {
    const first = codexAdapter.input(ctx, 'Fix the README', { first: true, sessionId: null })
    expect(first.startsWith(WORKER_INSTRUCTIONS)).toBe(true)
    expect(first).toContain('This job may change files')
    expect(first.endsWith('Fix the README')).toBe(true)
    expect(codexAdapter.input(ctx, 'and the tests', { first: false, sessionId: '0199c000-0000-7000-8000-000000000001' })).toBe('and the tests')
  })

  it('turns off only the features this version knows, and always the shell', () => {
    expect(codexFeatureArgs(undefined)).toEqual(['-c', 'features.shell_tool=false'])
    expect(codexFeatureArgs(new Set(['shell_tool', 'apps']))).toEqual(['-c', 'features.shell_tool=false', '-c', 'features.apps=false'])
  })
})

describe('the probe', () => {
  const features = fixture('codex-features-list.txt')
  const featuresOff = features.replace(/^(shell_tool|unified_exec|multi_agent|skill_mcp_dependency_install)(\s+\S+\s+)true$/gm, '$1$2false')
  const runner = (answer: (args: string[]) => { code: number; stdout: string; stderr?: string }): ProbeRunner & { calls: string[][] } => {
    const calls: string[][] = []
    const f = (async (args: readonly string[]) => {
      calls.push([...args])
      const a = answer([...args])
      return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' }
    }) as ProbeRunner & { calls: string[][] }
    f.calls = calls
    return f
  }
  const help = 'Usage: codex exec [OPTIONS] [PROMPT]\n  --json\n  --skip-git-repo-check\n  -s, --sandbox <MODE>\n  --ignore-user-config\n  --ignore-rules\n  -C, --cd <DIR>\n  --color <COLOR>\n'
  const modern = (overrides: Partial<Record<string, { code: number; stdout: string; stderr?: string }>> = {}) =>
    runner((args) => {
      const key = args.join(' ')
      if (overrides[key]) return overrides[key]!
      if (key === '--version') return { code: 0, stdout: 'codex-cli 0.48.0\n' }
      if (key === 'exec --help') return { code: 0, stdout: help }
      if (key === 'features list') return { code: 0, stdout: features }
      if (args.at(-2) === 'features' && args.at(-1) === 'list') return { code: 0, stdout: featuresOff }
      if (key === 'login status') return { code: 0, stdout: 'Logged in using ChatGPT' }
      return { code: 2, stdout: '', stderr: 'unexpected' }
    })

  it('checks the flags, reads the features, verifies the shell is off with the overrides, and the login', async () => {
    const r = modern()
    const probe = await codexAdapter.probe(r)
    expect(probe.version).toBe('0.48.0')
    expect([...probe.flags].sort()).toEqual(['--color', '--ignore-rules'])
    expect(probe.features?.has('shell_tool')).toBe(true)
    expect(r.calls.map((c) => c.filter((a) => a !== '-c' && !a.startsWith('features.')).join(' '))).toEqual(['--version', 'exec --help', '--help', 'features list', 'features list', 'login status'])
    expect(r.calls[4]).toContain('features.shell_tool=false')
  })

  it("leaves the person's config out of features list and login status too, where this Codex takes --ignore-user-config there", async () => {
    const r = runner((args) => {
      const key = args.join(' ')
      if (key === '--version') return { code: 0, stdout: 'codex-cli 0.48.0\n' }
      if (key === 'exec --help') return { code: 0, stdout: help }
      if (key === '--help') return { code: 0, stdout: 'Usage: codex [OPTIONS] [PROMPT]\n  --ignore-user-config\n  -c, --config <key=value>\n' }
      if (args[0] !== '--ignore-user-config') return { code: 2, stdout: '', stderr: 'read the config' }
      if (key === '--ignore-user-config features list') return { code: 0, stdout: features }
      if (args.at(-1) === 'list') return { code: 0, stdout: featuresOff }
      return key === '--ignore-user-config login status' ? { code: 0, stdout: 'Logged in using ChatGPT' } : { code: 2, stdout: '' }
    })
    await codexAdapter.probe(r)
    expect(r.calls.slice(3).map((c) => [c[0], c.at(-1)])).toEqual([
      ['--ignore-user-config', 'list'],
      ['--ignore-user-config', 'list'],
      ['--ignore-user-config', 'status'],
    ])
  })

  it('refuses the 0.34.0 on this Mac (recorded --help: no --ignore-user-config)', async () => {
    const r = modern({ '--version': { code: 0, stdout: 'codex-cli 0.34.0' }, 'exec --help': { code: 0, stdout: fixture('codex-0.34.0-exec-help.txt') } })
    await expect(codexAdapter.probe(r)).rejects.toThrow(/0\.34\.0\) is too old.*--ignore-user-config.*npm install -g @openai\/codex@latest/)
  })

  it('refuses a Codex whose shell cannot be turned off, or does not show it off', async () => {
    await expect(codexAdapter.probe(modern({ 'features list': { code: 2, stdout: '', stderr: "error: unexpected argument 'list'" } }))).rejects.toThrow(/can't turn off its built-in shell/)
    const stillOn = runner((args) => {
      const key = args.join(' ')
      if (key === '--version') return { code: 0, stdout: 'codex-cli 0.48.0' }
      if (key === 'exec --help') return { code: 0, stdout: help }
      if (args.at(-1) === 'list') return { code: 0, stdout: features } // the overrides did not take
      return { code: 0, stdout: '' }
    })
    await expect(codexAdapter.probe(stillOn)).rejects.toThrow(/didn't turn off its built-in shell \(shell_tool, unified_exec/)
  })

  it('says "not signed in" from login status', async () => {
    await expect(codexAdapter.probe(modern({ 'login status': { code: 1, stdout: 'Not logged in' } }))).rejects.toThrow(/isn't signed in.*codex login/)
  })
})

describe('parseFeatureList', () => {
  it('reads name and state, ignoring other lines', () => {
    const m = parseFeatureList('Feature  Stage  Enabled\nshell_tool  stable  false\nweird line here\nundo stable on\n\n')
    expect(m.get('shell_tool')).toBe(false)
    expect(m.get('undo')).toBe(true)
    expect(m.has('Feature')).toBe(false)
  })
})

describe('describeExit', () => {
  it.each([
    ["error: unexpected argument '--ignore-user-config' found", /too old/],
    ['Error: MCP client for `ni_folder` failed to start: connection refused', /couldn't reach the folder's tools/],
    ['Error: 401 Unauthorized', /isn't signed in/],
    ['thread panicked', /stopped unexpectedly \(exit 1\): thread panicked/],
  ])('%s', (stderr, expected) => {
    expect(codexAdapter.describeExit(1, null, stderr)).toMatch(expected)
  })
})
