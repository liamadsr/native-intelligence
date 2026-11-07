/**
 * The Claude Code adapter on recorded output. `claude-code-2.1.292-*` was
 * recorded from the real CLI on 2026-10-21 (under the worker's own profile,
 * connected to the fence's MCP server, signed out so no model ran; paths and
 * ids replaced). The other fixtures are built from those recorded shapes. No
 * CLI runs here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterContext, CliOutput, ProbeRunner } from '../lib/adapter'
import { CLAUDE_REQUIRED_FLAGS, FENCE_TOOL_NAMES, claudeArgs, claudeProjectKey, claudeCodeAdapter, claudeMcpConfig, claudeResultError, claudeUserLine, createClaudeNormalizer, neutralizeClaudeText, settingsReferencedFiles } from '../lib/claude-code'
import { WorkerLaunchError } from '../lib/env'
import { workerInstructions } from '../lib/instructions'

const FIXTURES = join(__dirname, 'fixtures')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const run = (name: string): CliOutput[] => {
  const normalize = createClaudeNormalizer()
  return fixture(name)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => normalize(l))
}
const events = (out: CliOutput[]) => out.flatMap((o) => (o.kind === 'event' ? [o.event] : []))

const ctx: AdapterContext = {
  launch: { worker: 'claude-code', bin: '/b/claude', binPath: '/b/claude', jobId: 'job1', folder: '/Users/p/app', mode: 'read', toolPath: '/usr/bin', home: '/Users/p', tmpdir: '/t', lang: 'en_US.UTF-8' },
  mcp: { url: 'http://127.0.0.1:4100/mcp', token: 'tok' },
  cliTmp: '/private/tmp/dial8-cli-x',
  cliCwd: '/Users/p/Library/job1/cli',
}

describe('the recorded 2.1.292 session (signed out)', () => {
  it('passes the init check: only the fence tools, and the fence server connected', () => {
    const out = run('claude-code-2.1.292-signed-out.jsonl')
    expect(out.some((o) => o.kind === 'violation')).toBe(false)
    const init = JSON.parse(fixture('claude-code-2.1.292-signed-out.jsonl').split('\n')[0])
    expect([...init.tools].sort()).toEqual([...FENCE_TOOL_NAMES].sort())
  })

  it("counts the replayed message as taken up, drops the CLI's stand-in error message, and ends the turn with the sign-in sentence", () => {
    const out = run('claude-code-2.1.292-signed-out.jsonl')
    expect(out.filter((o) => o.kind === 'consumed')).toHaveLength(1)
    expect(events(out)).toEqual([{ kind: 'error', message: expect.stringMatching(/isn't signed in.*run `claude`/) }])
    // 2.1.292's result carries queued_turn_count: nothing else queued.
    expect(out.at(-1)).toEqual({ kind: 'turn_end', more: false })
  })
})

describe('a whole turn', () => {
  it('maps text, tools, results and the manager calls to the launcher events', () => {
    const out = run('claude-code-turn.jsonl')
    expect(out.some((o) => o.kind === 'violation')).toBe(false)
    expect(events(out)).toEqual([
      { kind: 'text', delta: "I'll look " },
      { kind: 'text', delta: 'at the README.' },
      { kind: 'message', text: "I'll look at the README." },
      { kind: 'report', text: 'Reading the README and the src folder.' },
      { kind: 'tool', callId: 'toolu_bash1', name: 'bash', input: '{"command":"cat README.md && ls src"}' },
      { kind: 'tool_result', callId: 'toolu_bash1', name: 'bash', ok: true, output: JSON.stringify('exit code: 0\n# Demo\nA tiny demo.\nindex.ts') },
      { kind: 'tool', callId: 'toolu_read1', name: 'read_file', input: '{"path":"/workspace/missing.ts"}' },
      { kind: 'tool_result', callId: 'toolu_read1', name: 'read_file', ok: false, output: JSON.stringify('/workspace/missing.ts does not exist.') },
      { kind: 'finish', summary: 'A tiny demo project with one source file.' },
      { kind: 'text', delta: 'Done.' },
      { kind: 'message', text: 'Done.' },
    ])
    // The manager calls' results never show as tool results, and the result line closes the turn.
    expect(out.at(-1)).toEqual({ kind: 'turn_end', more: false })
  })

  it('says when another queued turn follows', () => {
    const ends = run('claude-code-queued.jsonl').filter((o) => o.kind === 'turn_end')
    expect(ends).toEqual([
      { kind: 'turn_end', more: true },
      { kind: 'turn_end', more: false },
    ])
  })
})

describe('the fence checks', () => {
  it('stops a CLI whose init offers built-in tools', () => {
    expect(run('claude-code-builtin-tools.jsonl')).toEqual([{ kind: 'violation', message: expect.stringMatching(/outside the folder's fence \(Bash, Read\)/) }])
  })

  it('stops a CLI whose fence server did not connect', () => {
    expect(run('claude-code-fence-failed.jsonl')).toEqual([{ kind: 'violation', message: expect.stringMatching(/couldn't reach the folder's tools \(failed\)/) }])
  })

  it('stops a call to any tool outside the fence server', () => {
    const normalize = createClaudeNormalizer()
    normalize(fixture('claude-code-2.1.292-signed-out.jsonl').split('\n')[0]) // the init that passes
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' } }] }, parent_tool_use_id: null })
    expect(normalize(line)).toContainEqual({ kind: 'violation', message: expect.stringMatching(/called Bash/) })
  })

  it.each([
    [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }],
    [{ type: 'mcp_tool_use', id: 'm1', name: 'read', server_name: 'remote', input: {} }],
    [{ type: 'web_fetch_tool_result', tool_use_id: 's1', content: {} }],
  ])('stops an answer with a tool the API runs itself: %j', (block) => {
    const normalize = createClaudeNormalizer()
    normalize(fixture('claude-code-2.1.292-signed-out.jsonl').split('\n')[0])
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }, block] }, parent_tool_use_id: null })
    expect(normalize(line)).toContainEqual({ kind: 'violation', message: expect.stringMatching(new RegExp(`a tool the API runs itself \\(${block.type}\\)`)) })
    // As it starts streaming, too.
    const start = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: block }, parent_tool_use_id: null })
    expect(normalize(start)).toEqual([{ kind: 'violation', message: expect.stringMatching(/a tool the API runs itself/) }])
  })

  it("lets the CLI's own tool calls and text start streaming", () => {
    const normalize = createClaudeNormalizer()
    normalize(fixture('claude-code-2.1.292-signed-out.jsonl').split('\n')[0])
    for (const content_block of [{ type: 'tool_use', id: 't1', name: 'mcp__dial8_folder__bash', input: {} }, { type: 'text', text: '' }, { type: 'thinking', thinking: '' }]) {
      expect(normalize(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block }, parent_tool_use_id: null }))).toEqual([{ kind: 'activity' }])
    }
  })

  it('refuses any permission request, and answers other control requests with an error', () => {
    const normalize = createClaudeNormalizer()
    const [deny] = normalize(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }))
    expect(deny.kind).toBe('reply')
    expect(JSON.parse((deny as { line: string }).line)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: expect.any(String) } },
    })
    const [other] = normalize(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }))
    expect(JSON.parse((other as { line: string }).line).response).toMatchObject({ subtype: 'error', request_id: 'r2' })
  })

  it('stops a CLI that works before its init line passed the check (no init: the check never ran)', () => {
    for (const line of [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}},"parent_tool_use_id":null}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"parent_tool_use_id":null}',
    ]) {
      expect(createClaudeNormalizer()(line)).toEqual([{ kind: 'violation', message: expect.stringMatching(/without reporting its tools/) }])
    }
    // An error result with no init (the CLI failed early) is reported, not a violation.
    expect(createClaudeNormalizer()('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}')[0]).toMatchObject({ kind: 'event' })
  })

  it("ignores stray non-JSON output, and stops on a subagent's line (with no Task tool there can be none)", () => {
    const normalize = createClaudeNormalizer()
    expect(normalize('Warning: something')).toEqual([])
    expect(normalize(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] }, parent_tool_use_id: 'toolu_x' }))).toEqual([
      { kind: 'violation', message: expect.stringMatching(/ran a subagent/) },
    ])
  })

  it('stops an init that offers fewer fence tools than are served', () => {
    const init = JSON.parse(fixture('claude-code-2.1.292-signed-out.jsonl').split('\n')[0])
    init.tools = init.tools.slice(1)
    expect(createClaudeNormalizer()(JSON.stringify(init))).toEqual([{ kind: 'violation', message: expect.stringMatching(/didn't offer the folder's tools as served/) }])
  })
})

describe('claudeResultError', () => {
  it.each([
    [{ result: 'Not logged in · Please run /login', is_error: true }, /isn't signed in/],
    // The 401 result Dial8's old Claude Code chat recorded (src/lib/claude-session, removed 2026-10).
    [{ subtype: 'success', is_error: true, api_error_status: 401, error: 'authentication_failed', result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials' }, /isn't signed in/],
    [{ result: 'Claude AI usage limit reached|1761000000', is_error: true }, /usage limit reached.*send a message to continue/],
    [{ subtype: 'error_max_turns', result: '' }, /Claude Code: error_max_turns/],
  ])('%j', (e, expected) => {
    expect(claudeResultError(e)).toMatch(expected)
  })
})

describe('starting the CLI', () => {
  const probe = { version: '2.1.292', flags: new Set(['--replay-user-messages', '--restricted', '--permission-prompts', '--no-chrome']) }

  it('turns off every built-in tool and every setting source, and allows only the fence tools', () => {
    const args = claudeArgs(ctx, probe, { sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', resume: false })
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    expect(args.slice(0, 2)).toEqual(['-p', '--verbose'])
    expect(after('--tools')).toBe('')
    expect(after('--setting-sources')).toBe('')
    expect(args).toContain('--session-id=aaaaaaaa-1111-4222-8333-444444444444') // one argv element
    expect(after('--mcp-config')).toBe('/private/tmp/dial8-cli-x/mcp.json')
    expect(after('--allowedTools').split(',')).toEqual(FENCE_TOOL_NAMES)
    expect(after('--permission-prompts')).toBe('none')
    expect(after('--append-system-prompt')).toBe(workerInstructions('read'))
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--restricted', '--no-chrome', '--replay-user-messages']) expect(args).toContain(f)
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('resumes by the same id, and leaves out flags this version lacks', () => {
    const args = claudeArgs(ctx, { version: '2.0.0', flags: new Set() }, { sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', resume: true })
    expect(args).toContain('--resume=aaaaaaaa-1111-4222-8333-444444444444')
    expect(args.some((a) => a.startsWith('--session-id'))).toBe(false)
    for (const f of ['--restricted', '--permission-prompts', '--replay-user-messages']) expect(args).not.toContain(f)
  })

  it('takes only a UUID session id, so nothing from outside can become a flag', () => {
    for (const bad of ['--settings={"hooks":{}}', '-x', '--plugin-url=https://x', 'sid-1', 'AAAAAAAA-1111-4222-8333-444444444444', '']) {
      for (const resume of [true, false]) expect(() => claudeArgs(ctx, { version: '2', flags: new Set() }, { sessionId: bad, resume }), bad).toThrow(/UUID/)
    }
  })

  it('points the MCP config at the fence server with the bearer, and writes stream-json user lines', () => {
    expect(JSON.parse(claudeMcpConfig(ctx.mcp))).toEqual({
      mcpServers: { dial8_folder: { type: 'http', url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer tok' } } },
    })
    const line = claudeUserLine('hi there', 'sid-1')
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: 'hi there' }, parent_tool_use_id: null, session_id: 'sid-1' })
  })

  it("leaves nothing in a message for Claude Code's prompt parser to act on", () => {
    const WJ = '\u2060'
    expect(neutralizeClaudeText('look at @~/.claude.json and (@/Users/me/.ssh/id_ed25519)')).toBe(`look at ${WJ}@~/.claude.json and (${WJ}@/Users/me/.ssh/id_ed25519)`)
    expect(neutralizeClaudeText('@README.md first')).toBe(`${WJ}@README.md first`)
    for (const cmd of ['/add-dir /Users/me', '!cat ~/.codex/auth.json', '# remember this', '  /login']) expect(neutralizeClaudeText(cmd).startsWith(WJ)).toBe(true)
    // An email address is not a mention, and ordinary text is untouched.
    expect(neutralizeClaudeText('[From Liam] mail liam@dial8.ai about it')).toBe('[From Liam] mail liam@dial8.ai about it')
    expect(JSON.parse(claudeUserLine('/compact', 's')).message.content).toBe(`${WJ}/compact`)
  })

  it('protects the parts of its state that hold code it would run later', () => {
    const p = claudeCodeAdapter.protectedState('/Users/p')
    for (const d of ['plugins', 'hooks', 'agents', 'commands', 'skills', 'local', 'bin', 'scheduled-tasks', 'projects/*/memory']) expect(p.dirs).toContain(`/Users/p/.claude/${d}`)
    expect(p.files).toContain('/Users/p/.claude/settings.json')
    expect(p.files).toContain('/Users/p/.claude/settings.local.json')
    // Any script it writes under ~/.claude, whatever a setting may name later.
    expect(p.scriptsUnder).toEqual(['/Users/p/.claude'])
  })

  it('protects every file under ~/.claude that a setting names (a status line or hook script), however it is spelled', () => {
    const settings: Record<string, string> = {
      '/Users/p/.claude/settings.json': JSON.stringify({
        statusLine: { type: 'command', command: '~/.claude/statusline' },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'bash "$HOME/.claude/tools/notify" --quiet; ${HOME}/.claude/x/y.cfg' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'bash "$HOME"/.claude/quoted && node --import=$HOME/.claude/preload "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cfgdir"' }] }],
        },
        apiKeyHelper: '/Users/p/.claude/helper',
        other: ['~/.claude/../.ssh/id', '~/elsewhere/z', 'plain text', '~/.claude/./dotted', '~/.claude/scripts/'],
      }),
      '/Users/p/.claude/settings.local.json': 'not json',
    }
    const read = (path: string) => {
      if (!(path in settings)) throw new Error('ENOENT')
      return settings[path]
    }
    expect(settingsReferencedFiles('/Users/p', read)).toEqual([
      '/Users/p/.claude/cfgdir',
      '/Users/p/.claude/dotted',
      '/Users/p/.claude/helper',
      '/Users/p/.claude/preload',
      '/Users/p/.claude/quoted',
      '/Users/p/.claude/scripts',
      '/Users/p/.claude/statusline',
      '/Users/p/.claude/tools/notify',
      '/Users/p/.claude/x/y.cfg',
    ])
    expect(settingsReferencedFiles('/Users/p', () => { throw new Error('ENOENT') })).toEqual([])
  })

  it('protects a folder the settings name with all it holds, except one the CLI writes as it runs', () => {
    const home = mkdtempSync(join(tmpdir(), 'la-claude-home-'))
    try {
      mkdirSync(join(home, '.claude'))
      writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'find ~/.claude/projects -mtime +30; ~/.claude/scripts/clean' }] }] } }))
      const p = claudeCodeAdapter.protectedState(home)
      expect(p.files).toEqual(expect.arrayContaining([join(home, '.claude/projects'), join(home, '.claude/scripts/clean')]))
      expect(p.dirs).toContain(join(home, '.claude/scripts/clean'))
      expect(p.dirs).not.toContain(join(home, '.claude/projects')) // its sessions live there
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('writes only its own project folder, named as Claude Code names it; a name it would cut is refused', () => {
    expect(claudeProjectKey('/private/tmp/claude-501/x y/jobs/j.1/cli')).toBe('-private-tmp-claude-501-x-y-jobs-j-1-cli')
    expect(claudeCodeAdapter.ownOnlyUnder!('/Users/p', '/Users/p/Library/jobs/j1/cli')).toEqual([{ parent: '/Users/p/.claude/projects', own: '/Users/p/.claude/projects/-Users-p-Library-jobs-j1-cli' }])
    expect(() => claudeCodeAdapter.ownOnlyUnder!('/Users/p', `/Users/p/${'a'.repeat(200)}/cli`)).toThrow(WorkerLaunchError)
    expect(() => claudeCodeAdapter.ownOnlyUnder!('/Users/p', `/Users/p/${'a'.repeat(200)}/cli`)).toThrow(/too long for Claude Code/)
  })

  it("keeps the CLI's temp files, updater and memory to itself", () => {
    expect(claudeCodeAdapter.env(ctx)).toMatchObject({ CLAUDE_CODE_TMPDIR: ctx.cliTmp, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
    expect(claudeCodeAdapter.stateDirs('/Users/p')).toContain('/Users/p/.claude')
    expect(claudeCodeAdapter.stateFiles('/Users/p')).toEqual(['/Users/p/.claude.json'])
  })
})

describe('the probe', () => {
  const help = fixture('claude-code-2.1.292-help.txt')
  const runner = (answers: Record<string, { code: number; stdout: string; stderr?: string }>): ProbeRunner & { calls: string[][] } => {
    const calls: string[][] = []
    const f = (async (args: readonly string[]) => {
      calls.push([...args])
      const a = answers[args.join(' ')] ?? { code: 1, stdout: '', stderr: 'unknown' }
      return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' }
    }) as ProbeRunner & { calls: string[][] }
    f.calls = calls
    return f
  }

  it('reads the version and the optional flags from the recorded --help, and the login', async () => {
    const r = runner({ '--version': { code: 0, stdout: '2.1.292 (Claude Code)\n' }, '--help': { code: 0, stdout: help }, 'auth status --json': { code: 0, stdout: '{"loggedIn":true}' } })
    const probe = await claudeCodeAdapter.probe(r)
    expect(probe.version).toBe('2.1.292')
    expect([...probe.flags].sort()).toEqual(['--no-chrome', '--permission-prompts', '--replay-user-messages', '--restricted'])
    expect(r.calls).toEqual([['--version'], ['--help'], ['auth', 'status', '--json']])
  })

  it('every required flag is in the recorded --help', () => {
    const listed = help.match(/--[a-zA-Z][\w-]*/g) ?? []
    for (const f of CLAUDE_REQUIRED_FLAGS) expect(listed).toContain(f)
  })

  it('says "not signed in" from auth status, before anything runs', async () => {
    const r = runner({ '--version': { code: 0, stdout: '2.1.292 (Claude Code)' }, '--help': { code: 0, stdout: help }, 'auth status --json': { code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' } })
    await expect(claudeCodeAdapter.probe(r)).rejects.toThrow(/isn't signed in/)
  })

  it('refuses a CLI too old for the fence flags, naming them', async () => {
    const old = help.replaceAll('--tools', '').replaceAll('--setting-sources', '')
    const r = runner({ '--version': { code: 0, stdout: '1.0.80 (Claude Code)' }, '--help': { code: 0, stdout: old } })
    const err = await claudeCodeAdapter.probe(r).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerLaunchError)
    expect((err as Error).message).toMatch(/1\.0\.80.*too old.*--tools, --setting-sources.*claude update/)
  })

  it('never runs `auth status` on a CLI that does not list the command (it would be read as a prompt)', async () => {
    const noAuth = help.replace(/^ {2}auth .*$/m, '')
    const r = runner({ '--version': { code: 0, stdout: '2.1.0 (Claude Code)' }, '--help': { code: 0, stdout: noAuth } })
    await claudeCodeAdapter.probe(r)
    expect(r.calls).toEqual([['--version'], ['--help']])
  })

  it('reports a CLI that does not start', async () => {
    await expect(claudeCodeAdapter.probe(runner({ '--version': { code: 126, stdout: '', stderr: 'Killed: 9' } }))).rejects.toThrow(/didn't start on this Mac: Killed: 9/)
  })
})

describe('describeExit', () => {
  it.each([
    ['error: unknown option --tools', /too old.*claude update/],
    ['Not logged in · Please run /login', /isn't signed in/],
    ['Segmentation fault', /stopped unexpectedly \(exit 1\): Segmentation fault/],
  ])('%s', (stderr, expected) => {
    expect(claudeCodeAdapter.describeExit(1, null, stderr)).toMatch(expected)
  })
})
