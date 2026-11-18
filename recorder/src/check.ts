/**
 * The notes' preflight: `node src/main.ts --check`, run inside the recorder's
 * container (`docker compose exec -T recorder node src/main.ts --check` in
 * deploy/livekit), proves what a call's notes need without a call, and costs
 * nothing:
 *
 *   recorder   the running recorder process answers its health port, and has
 *              heard from the app lately.
 *   app        the app takes the feed's secret, the recorder is on there, and
 *              (its answer) whether the live agent is on and answers.
 *   livekit    LiveKit answers where the recorder joins rooms.
 *   deepgram   the key is taken (management API) and may stream (a socket
 *              opened and closed before any audio).
 *
 * One line per check, "ok" or "FAIL" and why, never a secret; exit 0 when
 * every check passed, else 1.
 */
import { AppError, type AppClient } from './app-client.ts'
import { checkDeepgramKey, checkDeepgramStream, type Fetch } from './deepgram-check.ts'
import type { SocketFactory } from './deepgram.ts'

export interface CheckLine {
  name: string
  ok: boolean
  detail: string
}

export interface CheckDeps {
  client: Pick<AppClient, 'check' | 'work'>
  healthPort: number
  livekitUrl: string
  deepgramUrl: string
  deepgramKey: string
  fetch?: Fetch
  socket?: SocketFactory
}

/** The running process's own health answer (the compose health check's). */
async function recorderLine(deps: CheckDeps, doFetch: Fetch): Promise<CheckLine> {
  try {
    const res = await doFetch(`http://127.0.0.1:${deps.healthPort}/`, { signal: AbortSignal.timeout(3_000) })
    const json = (await res.json().catch(() => null)) as { ok?: boolean; calls?: number; appOkSecondsAgo?: number | null } | null
    if (!res.ok || !json?.ok) return { name: 'recorder', ok: false, detail: `its loop is not running (health answered ${res.status})` }
    const ago = json.appOkSecondsAgo
    if (typeof ago !== 'number') return { name: 'recorder', ok: false, detail: 'running, but it has not reached the app since it started' }
    if (ago > 60) return { name: 'recorder', ok: false, detail: `running, but it last reached the app ${ago} s ago` }
    return { name: 'recorder', ok: true, detail: `running, in ${json.calls ?? 0} call(s), reached the app ${ago} s ago` }
  } catch {
    return { name: 'recorder', ok: false, detail: `no answer on 127.0.0.1:${deps.healthPort} (run this inside the recorder's container)` }
  }
}

async function appLines(deps: CheckDeps): Promise<CheckLine[]> {
  try {
    const out = (await deps.client.check()) as { recorder?: boolean; liveAgent?: boolean; liveAgentHealth?: string; turnKey?: boolean; livekit?: boolean }
    const lines: CheckLine[] = [{ name: 'app', ok: out.recorder === true, detail: out.recorder === true ? 'takes the feed secret; the recorder is on' : 'the recorder is off in the app (TEAM_CALL_RECORDER)' }]
    if (out.liveAgent === true) {
      const ready = out.liveAgentHealth === 'ready'
      const signs = out.turnKey !== false
      lines.push({
        name: 'live agent',
        ok: ready && signs,
        detail: !ready ? `on, but it does not answer (${out.liveAgentHealth ?? 'unknown'})` : signs ? 'on, and answers' : 'answers, but the app cannot sign its turns (no internal secret for the live agent)',
      })
    } else {
      lines.push({ name: 'live agent', ok: false, detail: 'off in the app (TEAM_CALL_LIVE_AGENT): no live summary during calls' })
    }
    return lines
  } catch (err) {
    const status = err instanceof AppError ? err.status : 0
    if (status === 401) return [{ name: 'app', ok: false, detail: 'refused the feed secret (CAPTURE_FEED_SECRET differs from the app’s)' }]
    if (status === 404) {
      // The check route is newer than some builds: the work route tells on its own.
      try {
        await deps.client.work([], 0)
        return [{ name: 'app', ok: true, detail: 'takes the feed secret; the recorder is on (this app build has no check route: the live agent was not checked)' }]
      } catch (again) {
        const s = again instanceof AppError ? again.status : 0
        return [{ name: 'app', ok: false, detail: s === 404 ? 'the recorder is off in the app (TEAM_CALL_RECORDER), or the feed is (CAPTURE_FEED_SECRET)' : `answered ${s || 'nothing'}` }]
      }
    }
    return [{ name: 'app', ok: false, detail: status ? `answered ${status}` : 'unreachable (RECORDER_APP_URL)' }]
  }
}

async function livekitLine(deps: CheckDeps, doFetch: Fetch): Promise<CheckLine> {
  const url = deps.livekitUrl.replace(/^ws/, 'http')
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(3_000) })
    return { name: 'livekit', ok: res.ok, detail: res.ok ? 'answers' : `answered ${res.status}` }
  } catch {
    return { name: 'livekit', ok: false, detail: 'no answer (RECORDER_LIVEKIT_URL)' }
  }
}

async function deepgramLines(deps: CheckDeps): Promise<CheckLine[]> {
  const key = await checkDeepgramKey({ streamUrl: deps.deepgramUrl, key: deps.deepgramKey, fetch: deps.fetch })
  const stream = await checkDeepgramStream({ url: deps.deepgramUrl, key: deps.deepgramKey, socket: deps.socket })
  const keyDetail =
    key.verdict === 'ok'
      ? `key taken${key.balance ? `, balance ${key.balance.amount} ${key.balance.units}`.trimEnd() : ''}`
      : key.verdict === 'refused'
        ? 'key refused (401): RECORDER_DEEPGRAM_API_KEY is wrong or revoked'
        : key.verdict === 'no_credit'
          ? 'the account cannot pay (402): add credit'
          : key.verdict === 'unreachable'
            ? 'Deepgram unreachable from here'
            : key.status === 403
              ? 'this key may not read projects (403); the stream check decides'
              : `answered ${key.status}`
  const keyOk = key.verdict === 'ok' || (key.status === 403 && stream === 'open')
  const lowBalance = !!key.balance && key.balance.amount <= 1
  return [
    { name: 'deepgram key', ok: keyOk && !lowBalance, detail: lowBalance ? `${keyDetail} (almost none left)` : keyDetail },
    { name: 'deepgram stream', ok: stream === 'open', detail: stream === 'open' ? 'a socket opened with the key (no audio sent)' : stream === 'timeout' ? 'no socket within 8 s' : 'the socket was refused' },
  ]
}

/** Every check, in order. */
export async function runChecks(deps: CheckDeps): Promise<CheckLine[]> {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init))
  const [recorder, app, livekit, deepgram] = await Promise.all([recorderLine(deps, doFetch), appLines(deps), livekitLine(deps, doFetch), deepgramLines(deps)])
  return [recorder, ...app, livekit, ...deepgram]
}

/** The lines as printed. */
export function formatChecks(lines: readonly CheckLine[]): string {
  return lines.map((l) => `${l.ok ? 'ok  ' : 'FAIL'} ${l.name}: ${l.detail}`).join('\n')
}
