/**
 * Headless repro harness for the eve chat ask_user HITL flow, against the LOCAL
 * eve dev stack (next dev + eve dev children on localhost:3000).
 *
 * Drives the REAL EveChatTransport (the exact class the browser panel uses):
 *   1. mints a DEV Supabase session for the target user (magiclink, headless),
 *   2. sends a message that forces an ask_user call,
 *   3. waits for the picker part (tool-input-available / ask_user),
 *   4. answers it via transport.answerPermission (the Submit path),
 *   5. asserts the model CONTINUES (text after the answer) and the turn closes.
 *
 * Run:  node \
 *         node_modules/.bin/tsx scripts/eve-ask-user-repro.ts [--dismiss]
 *
 * DEV-ONLY tooling — never wired into the build. Uses .env.development.local.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    let val = m[2]
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
// tsx compiles this entry as CJS (no "type":"module"), so __dirname exists.
const ROOT = resolve(__dirname, '..')
loadEnvFile(resolve(ROOT, '.env.development.local'))
loadEnvFile(resolve(ROOT, '.env.local'))

async function main(): Promise<void> {
  const BASE = process.env.REPRO_BASE_URL || 'http://localhost:3000'
  const EMAIL = process.env.REPRO_EMAIL || 'you@example.com'
  const DISMISS = process.argv.includes('--dismiss')

  // ── fetch shim: the transport fetches relative URLs (browser-normal) ─────────
  const origFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) input = BASE + input
    else if (input instanceof URL && input.protocol === 'null:') input = BASE + input.pathname
    return origFetch(input as RequestInfo, init)
  }) as typeof fetch

  // Import AFTER the shim so nothing captures the raw fetch at module load.
  const { EveChatTransport } = await import('../src/lib/chat/eve/eve-chat-transport')

  const ts = () => new Date().toISOString().slice(11, 23)
  const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a)

  // Tap the transport's private onEvent so the RAW eve event order is visible.
  if (process.env.REPRO_RAW === '1') {
    const proto = EveChatTransport.prototype as unknown as {
      onEvent: (event: unknown, turn: unknown) => void
    }
    const origOnEvent = proto.onEvent
    proto.onEvent = function (event: unknown, turn: unknown) {
      const e = event as { type: string; data?: unknown }
      console.log(`[${ts()}] [raw] ${e.type} ${JSON.stringify(e.data ?? {}).slice(0, 220)}`)
      return origOnEvent.call(this, event, turn)
    }
  }

  // ── 1. mint a DEV Supabase session (headless magiclink) ──────────────────────
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  if (!SUPABASE_URL.includes('edrjddsxjoigpbecqgfb')) {
    throw new Error(`refusing to run against non-DEV supabase: ${SUPABASE_URL}`)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: EMAIL,
  })
  if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: verified, error: otpErr } = await anon.auth.verifyOtp({
    type: 'email',
    token_hash: linkData.properties.hashed_token,
  })
  if (otpErr || !verified.session) throw new Error(`verifyOtp failed: ${otpErr?.message}`)
  const accessToken = verified.session.access_token
  log(`authed as ${EMAIL} (user ${verified.session.user.id})`)

  // ── 2. real transport, pointed at local eve ──────────────────────────────────
  const transport = new EveChatTransport({
    getAccessToken: () => accessToken,
    host: `${BASE}/eve/chat-agent`,
    onConversationEnsured: (_chatId: string, conversationId: string) =>
      log(`conversation ensured: ${conversationId}`),
    onSessionMinted: (_chatId: string, sessionId: string) => log(`eve session: ${sessionId}`),
  })

  const chatId = `repro-${Date.now()}`
  const PROMPT =
    'Use the ask_user tool RIGHT NOW to ask me exactly one question: "Which color should I use?" ' +
    'with options "Red" and "Blue". After I answer, reply with one short sentence naming the color I chose.'

  log(`sending turn (chat ${chatId})…`)
  const stream = await transport.sendMessages({
    chatId,
    messageId: 'u1',
    trigger: 'submit-message',
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: PROMPT }] }],
    abortSignal: undefined,
    headers: undefined,
    body: {},
    // The transport only reads chatId/messages/body/abortSignal off this bag.
  } as never)

  // ── 3/4/5. pump chunks; answer the picker when it appears ────────────────────
  let answeredCallId: string | null = null
  let textAfterAnswer = ''
  let sawFinish = false
  let answerIssuedAt = 0

  const reader = stream.getReader()
  const hardTimeout = setTimeout(() => {
    console.error(`\n!!! TIMEOUT: no turn completion within 180s — the resume died. Transcript above.`)
    process.exit(2)
  }, 180_000)

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const c = value as Record<string, unknown> & { type: string }

    switch (c.type) {
      case 'text-delta': {
        process.stdout.write(String(c.delta))
        if (answeredCallId) textAfterAnswer += String(c.delta)
        break
      }
      case 'text-start':
        process.stdout.write(`\n[${ts()}] text> `)
        break
      case 'text-end':
        process.stdout.write('\n')
        break
      case 'tool-input-available': {
        log(`tool-input-available: ${String(c.toolName)} call=${String(c.toolCallId)}`)
        if (c.toolName === 'ask_user' && !answeredCallId) {
          const callId = String(c.toolCallId)
          answeredCallId = callId
          log(`picker surfaced — input: ${JSON.stringify(c.input).slice(0, 300)}`)
          // Answer like the panel does (Submit click), slightly delayed like a human.
          setTimeout(() => {
            answerIssuedAt = Date.now()
            log(DISMISS ? 'dismissing (X)…' : 'answering: Blue …')
            const p = DISMISS
              ? transport.answerPermission(chatId, callId, {}, 'User dismissed the question')
              : transport.answerPermission(chatId, callId, { 'Which color should I use?': 'Blue' })
            p.then(() => log('answerPermission resolved')).catch((e: unknown) =>
              console.error('answerPermission REJECTED:', e),
            )
          }, 750)
        }
        break
      }
      case 'tool-output-available':
        log(`tool-output-available: call=${String(c.toolCallId)} output=${JSON.stringify(c.output).slice(0, 200)}`)
        break
      case 'finish':
        sawFinish = true
        log('finish')
        break
      case 'error':
        console.error('stream error chunk:', c)
        break
      default:
        log(`chunk: ${c.type}`)
    }
  }
  clearTimeout(hardTimeout)

  log(`stream closed. answered=${!!answeredCallId} finish=${sawFinish}`)
  if (answeredCallId && answerIssuedAt) log(`resume latency: ${Date.now() - answerIssuedAt}ms`)

  if (!answeredCallId) {
    console.error('\nFAIL: the model never called ask_user (no picker to test).')
    process.exit(3)
  }
  if (!DISMISS && !textAfterAnswer.trim()) {
    console.error('\nFAIL (the bug): stream closed but the model never said anything after the answer.')
    process.exit(4)
  }
  if (!sawFinish) {
    console.error('\nFAIL: no finish chunk — turn did not close cleanly.')
    process.exit(5)
  }
  console.log(`\nPASS: model continued after ${DISMISS ? 'dismiss' : 'answer'} → "${textAfterAnswer.trim().slice(0, 200)}"`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
