/**
 * What the link tests share: a stand-in CLI run as a real process (no fence:
 * worker.e2e.test.ts runs the stand-ins under the profile), the real manager
 * tools' MCP server, and the events a link reports, recorded.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProcess, Launchers, LinkEvents, ToolEnd, ToolStart } from '../../lib/agent-link'
import { createManagerTools } from '../../lib/manager-tools'
import { startManagerMcp } from '../../lib/mcp-http'
import type { NormalizedEvent } from '../../lib/protocol'

export const FIXTURES = __dirname

export async function linkHarness(fixture: 'fake-claude.mjs' | 'fake-codex.mjs', opts: Record<string, unknown> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'la-link-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  const log = join(home, 'requests.jsonl')
  const env = { PATH: '/usr/bin:/bin', HOME: home, FAKE_LOG: log, FAKE_OPTS: JSON.stringify(opts) }
  const children: ChildProcess[] = []
  const launchers: Launchers = {
    spawn: (args) => {
      const child = spawn(process.execPath, [join(FIXTURES, fixture), ...args], { cwd, env: env as unknown as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      return child as unknown as AgentProcess
    },
    run: (args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(process.execPath, [join(FIXTURES, fixture), ...args], { cwd, env: env as unknown as NodeJS.ProcessEnv, timeout: timeoutMs }, (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, signal: null, stdout, stderr }),
        )
      }),
  }
  const calls: NormalizedEvent[] = []
  const mcp = await startManagerMcp(createManagerTools((e) => calls.push(e), 'read').call)
  const seen = { text: [] as [string, string | null][], toolStarts: [] as ToolStart[], toolEnds: [] as ToolEnd[], errors: [] as string[], models: [] as { model: string; effort?: string | null }[], logs: [] as string[] }
  const events: LinkEvents = {
    text: (d, id) => seen.text.push([d, id]),
    toolStart: (t) => seen.toolStarts.push(t),
    toolEnd: (t) => seen.toolEnds.push(t),
    error: (m) => seen.errors.push(m),
    model: (m) => seen.models.push(m),
    log: (l) => seen.logs.push(l),
  }
  const params = { cwd, instructions: '# Working for Native Intelligence\n\nBe brief.', mcp: { name: 'ni', url: mcp.url, token: mcp.token } }
  const requests = () =>
    (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as Record<string, unknown> & { method?: string; params?: Record<string, unknown>; argv?: string[]; stdin?: Record<string, unknown> })
  const text = () => seen.text.map(([d]) => d).join('')
  const close = async () => {
    for (const c of children) c.kill('SIGKILL')
    await mcp.close()
  }
  return { home, cwd, env, launchers, events, seen, calls, mcp, params, requests, text, children, close }
}
