import 'server-only'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

type TraceContext = { userId: string; workspaceId: string; runId?: string }
type TraceStage = 'task.queued' | 'native.observation' | 'jev.input' | 'jev.output' | 'jev.error' | 'helper.input' | 'helper.output' | 'decision.result' | 'task.settled'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RECORD_BYTES = 256_000
const MAX_FILE_BYTES = 4_000_000

/** Never serialize error messages, request/response bodies, URLs or headers. */
export function browserErrorDiagnostics(error: unknown): { name: string; statusCode?: number; retryable?: boolean; cause?: string } {
  const known = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AI_APICallError', 'AI_NoObjectGeneratedError',
    'AI_InvalidResponseDataError', 'AI_JSONParseError', 'AI_TypeValidationError', 'AI_RetryError', 'GatewayError'])
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const nested = value.cause && typeof value.cause === 'object' ? value.cause as Record<string, unknown> : {}
  return { name: typeof value.name === 'string' && known.has(value.name) ? value.name : 'unknown',
    ...(typeof value.statusCode === 'number' && Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 ? { statusCode: value.statusCode } : {}),
    ...(typeof value.isRetryable === 'boolean' ? { retryable: value.isRetryable } : {}),
    ...(typeof nested.name === 'string' && known.has(nested.name) ? { cause: nested.name } : {}),
  }
}

/** Explicit, expiring local diagnostics. No production logging, provider
 * transport objects, request headers, environment values or auth tokens.
 * The scope file is operator-created and is never supplied by a browser page.
 * Exact authorized page evidence stays in mode-0600 files, outside analytics. */
export async function writeBrowserDebugTrace(context: TraceContext, stage: TraceStage, data: unknown): Promise<void> {
  if (process.env.NODE_ENV !== 'development' || process.env.VERCEL || !context.runId || !UUID.test(context.runId)) return
  try {
    const scopePath = process.env.DIAL8_BROWSER_TRACE_SCOPE_FILE ?? join(tmpdir(), 'dial8-browser-trace-scope.json')
    const scope = JSON.parse(await readFile(scopePath, 'utf8'))
    const expiry = Date.parse(scope.expiresAt)
    if (scope.userId !== context.userId || scope.workspaceId !== context.workspaceId ||
        !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 30 * 60_000 ||
        (scope.runId && scope.runId !== context.runId) || typeof scope.outputDir !== 'string') return
    const directory = resolve(scope.outputDir)
    const allowedRoots = [resolve(tmpdir()), '/private/tmp', '/tmp']
    if (!allowedRoots.some(root => directory.startsWith(root + sep))) return
    const line = JSON.stringify({ timestamp: new Date().toISOString(), taskId: context.runId, stage, data }) + '\n'
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, context.runId + '.jsonl')
    const size = await stat(file).then(value => value.size, () => 0)
    if (size + Buffer.byteLength(line) > MAX_FILE_BYTES) return
    await appendFile(file, line, { mode: 0o600 })
    console.info('[browser-trace]', context.runId, stage)
  } catch {
    // Diagnostic I/O must never change authorization, billing or execution.
  }
}
