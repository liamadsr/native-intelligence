import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserErrorDiagnostics, writeBrowserDebugTrace } from '../local-debug-trace'

const context = { userId: 'test-user', workspaceId: 'test-workspace', runId: '00000000-0000-4000-8000-000000000001' }
let directory: string | undefined
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })

async function scope(overrides = {}) {
  directory = await mkdtemp(join(tmpdir(), 'browser-trace-test-'))
  const scopePath = join(directory, 'scope.json'), outputDir = join(directory, 'logs')
  await writeFile(scopePath, JSON.stringify({ userId: context.userId, workspaceId: context.workspaceId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), outputDir, ...overrides }))
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('VERCEL', '')
  vi.stubEnv('DIAL8_BROWSER_TRACE_SCOPE_FILE', scopePath)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  return join(outputDir, context.runId + '.jsonl')
}

describe('explicit local browser step tracing', () => {
  it('retains recognized provider status without leaking error messages, bodies, URLs, headers or foreign error names', () => {
    const error = { name: 'AI_APICallError', statusCode: 400, isRetryable: false, message: 'secret token',
      responseBody: 'private body', url: 'https://private.test', requestHeaders: { Authorization: 'secret' },
      cause: { name: 'TypeError', message: 'private cause' } }
    expect(browserErrorDiagnostics(error)).toEqual({ name: 'AI_APICallError', statusCode: 400, retryable: false, cause: 'TypeError' })
    expect(browserErrorDiagnostics({ ...error, name: 'secret token', statusCode: 999 })).toEqual({ name: 'unknown', retryable: false, cause: 'TypeError' })
  })
  it('retains exact scoped evidence in a private JSONL file', async () => {
    const file = await scope()
    const data = { step: 3, observation: { text: 'Observed public result', viewport: { scrollY: 420 } } }
    await writeBrowserDebugTrace(context, 'native.observation', data)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ taskId: context.runId, stage: 'native.observation', data })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
  it.each(['production', 'test'])('never logs in %s', async environment => {
    const file = await scope(); vi.stubEnv('NODE_ENV', environment)
    await writeBrowserDebugTrace(context, 'native.observation', { private: 'not retained' })
    await expect(stat(file)).rejects.toThrow()
  })
  it.each([{ workspaceId: 'other-workspace' }, { expiresAt: '2000-01-01T00:00:00Z' },
    { runId: '00000000-0000-4000-8000-000000000099' }, { outputDir: '/Users/shared' }])('rejects a mismatched or unsafe scope %j', async override => {
    const file = await scope(override)
    await writeBrowserDebugTrace(context, 'native.observation', { private: 'not retained' })
    await expect(stat(file)).rejects.toThrow()
  })
})
