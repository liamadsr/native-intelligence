/**
 * Generalized headless driver for the eve chat pipeline (local regression).
 * Drives the REAL EveChatTransport against the local dev stack, like the
 * browser panel does, and emits a machine-readable JSON verdict.
 *
 *   --prompt "..."      turn to send (repeatable → multi-turn, same session)
 *   --answer            answer any ask_user picker with each question's FIRST option
 *   --dismiss           dismiss any ask_user picker (the X path)
 *   --json              print ONLY the final JSON summary on stdout
 *   --out <file>        also write the JSON summary to <file>
 *   --skill <id>        send the turn with a preselected skill id
 *
 * Each tool call records its name, its INPUT, a truncated output, the skill a
 * load_skill resolved to, the areas whose expertise pack rode its result, and
 * whether it succeeded (`ok`; a failed call also carries its error `code` and
 * clipped `error`: an output-error, or an output with `success: false`).
 * The transport strips packs (`__expertise`) before the UI sees a result, so
 * the driver reads them off the raw eve stream: its fetch wrapper tees every
 * GET under /eve/chat-agent and scans the NDJSON for them, keyed by callId.
 *
 * Exit 0 always when the run itself completes; the JSON carries per-turn
 * outcomes for the caller to judge. Exit 1 on infra failure (auth, transport).
 *
 * Run:  node \
 *         node_modules/.bin/tsx scripts/eve-chat-driver.ts --prompt "..." [--json]
 *
 * DEV-ONLY tooling — never wired into the build. Uses .env.development.local.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

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
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
}
const ROOT = resolve(__dirname, '..')
loadEnvFile(resolve(ROOT, '.env.development.local'))
loadEnvFile(resolve(ROOT, '.env.local'))

interface ToolCallRecord {
  callId: string
  name: string
  /** The tool input as the model sent it. */
  input?: unknown
  hasOutput: boolean
  output?: string
  /** load_skill: the skill it resolved to (its output's `skill`). */
  skill?: string
  /** Areas whose expertise pack rode this call's result (read off the raw eve stream). */
  packs?: string[]
  /** False when the call errored or answered `success: false`; absent while no result came. */
  ok?: boolean
  /** A failed call's error code (INPUT_INVALID, REPEATED_FAILURE…), when it gave one. */
  code?: string
  /** A failed call's error text, clipped. */
  error?: string
}

/** The error code a failed call names: its output's `code`, or `[CODE]` in its error text. */
function errorCode(output: unknown, text: string): string | undefined {
  if (output && typeof output === 'object' && typeof (output as { code?: unknown }).code === 'string') return (output as { code: string }).code
  return /\[([A-Z][A-Z0-9_]+)\]/.exec(text)?.[1]
}
interface TurnRecord {
  prompt: string
  text: string
  toolCalls: ToolCallRecord[]
  askUserSeen: boolean
  askUserResolved: 'answered' | 'dismissed' | null
  /** Every area whose pack rode a result in this turn, in order. */
  packs: string[]
  finished: boolean
  error: string | null
  ms: number
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const prompts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) prompts.push(args[++i])
  }
  const ANSWER = args.includes('--answer')
  const DISMISS = args.includes('--dismiss')
  const JSON_ONLY = args.includes('--json')
  const skillIdx = args.indexOf('--skill')
  const SKILL_ID = skillIdx !== -1 ? args[skillIdx + 1] : undefined
  const outIdx = args.indexOf('--out')
  const OUT_FILE = outIdx !== -1 ? args[outIdx + 1] : undefined
  if (prompts.length === 0) {
    console.error('usage: eve-chat-driver.ts --prompt "..." [--prompt "..."] [--answer|--dismiss] [--json]')
    process.exit(1)
  }
  const log = (...a: unknown[]) => {
    if (!JSON_ONLY) console.log(...a)
  }

  const BASE = process.env.REPRO_BASE_URL || 'http://localhost:3000'
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) input = BASE + input
    const res = await origFetch(input as RequestInfo, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    // The eve session stream (GET, NDJSON): tee it so the packs the
    // transport strips can be read here; the transport gets the other branch.
    if (method === 'GET' && res.ok && res.body && url.includes('/eve/chat-agent/')) {
      const [forTransport, forScan] = res.body.tee()
      scanEveStream(forScan)
      return new Response(forTransport, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    return res
  }) as typeof fetch

  const { EveChatTransport } = await import('../src/lib/chat/eve/eve-chat-transport')

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  // DEV-only by default; REPRO_ALLOW_PROD=1 opts into a production smoke run
  // (creates a real conversation + usage row in the target account).
  if (!SUPABASE_URL.includes('edrjddsxjoigpbecqgfb') && process.env.REPRO_ALLOW_PROD !== '1') {
    throw new Error(`refusing to run against non-DEV supabase: ${SUPABASE_URL}`)
  }
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: process.env.REPRO_EMAIL || 'you@example.com',
  })
  if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)
  const anon = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: verified, error: otpErr } = await anon.auth.verifyOtp({
    type: 'email',
    token_hash: linkData.properties.hashed_token,
  })
  if (otpErr || !verified.session) throw new Error(`verifyOtp failed: ${otpErr?.message}`)
  const accessToken = verified.session.access_token

  let conversationId: string | null = null
  let eveSessionId: string | null = null
  const transport = new EveChatTransport({
    getAccessToken: () => accessToken,
    host: `${BASE}/eve/chat-agent`,
    onConversationEnsured: (_c: string, id: string) => {
      conversationId = id
    },
    onSessionMinted: (_c: string, id: string) => {
      eveSessionId = id
    },
  })

  const chatId = `driver-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const turns: TurnRecord[] = []

  for (const prompt of prompts) {
    const started = Date.now()
    const rec: TurnRecord = {
      prompt,
      text: '',
      toolCalls: [],
      askUserSeen: false,
      askUserResolved: null,
      packs: [],
      finished: false,
      error: null,
      ms: 0,
    }
    turns.push(rec)
    log(`>> turn: ${prompt.slice(0, 80)}`)

    try {
      const stream = await transport.sendMessages({
        chatId,
        messageId: `u-${turns.length}`,
        trigger: 'submit-message',
        messages: [
          { id: `u-${turns.length}`, role: 'user', parts: [{ type: 'text', text: prompt }] },
        ],
        abortSignal: undefined,
        headers: undefined,
        body: SKILL_ID ? { skillId: SKILL_ID } : {},
      } as never)

      const reader = stream.getReader()
      const byCallId = new Map<string, ToolCallRecord>()
      const deadline = setTimeout(() => {
        rec.error = 'TURN TIMEOUT (180s)'
        void reader.cancel().catch(() => {})
      }, 180_000)

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const c = value as Record<string, unknown> & { type: string }
        switch (c.type) {
          case 'text-delta':
            rec.text += String(c.delta)
            break
          case 'tool-input-available': {
            const name = String(c.toolName)
            const call: ToolCallRecord = { callId: String(c.toolCallId), name, input: c.input, hasOutput: false }
            byCallId.set(String(c.toolCallId), call)
            rec.toolCalls.push(call)
            log(`   tool: ${name}`)
            if (name === 'ask_user' && !rec.askUserResolved && (ANSWER || DISMISS)) {
              rec.askUserSeen = true
              const callId = String(c.toolCallId)
              const input = c.input as { questions?: Array<{ question: string; options?: Array<{ label: string }> }> }
              setTimeout(() => {
                if (DISMISS) {
                  rec.askUserResolved = 'dismissed'
                  void transport
                    .answerPermission(chatId, callId, {}, 'User dismissed the question')
                    .catch((e: unknown) => {
                      rec.error = `dismiss failed: ${e instanceof Error ? e.message : String(e)}`
                    })
                } else {
                  const answers: Record<string, string> = {}
                  for (const q of input?.questions ?? []) {
                    answers[q.question] = q.options?.[0]?.label ?? 'yes'
                  }
                  rec.askUserResolved = 'answered'
                  void transport.answerPermission(chatId, callId, answers).catch((e: unknown) => {
                    rec.error = `answer failed: ${e instanceof Error ? e.message : String(e)}`
                  })
                }
              }, 500)
            } else if (name === 'ask_user') {
              rec.askUserSeen = true
            }
            break
          }
          case 'tool-output-available': {
            const call = byCallId.get(String(c.toolCallId))
            if (call) {
              call.hasOutput = true
              call.output = JSON.stringify(c.output).slice(0, 400)
              const out = c.output as { skill?: unknown } | null
              if (call.name === 'load_skill' && out && typeof out === 'object' && typeof out.skill === 'string') {
                call.skill = out.skill
              }
              // A refusal the route answers as an output (REPEATED_FAILURE, a tool's own `success: false`).
              const failed = out && typeof out === 'object' && (out as { success?: unknown }).success === false
              call.ok = !failed
              if (failed) {
                const text = typeof (out as { error?: unknown }).error === 'string' ? String((out as { error: string }).error) : ''
                call.code = errorCode(out, text)
                if (text) call.error = text.slice(0, 300)
              }
            }
            break
          }
          case 'tool-output-error': {
            // eve marked the result failed (a thrown dispatch error, e.g. "<tool>: … [INPUT_INVALID] — details").
            const call = byCallId.get(String(c.toolCallId))
            if (call) {
              const text = String(c.errorText ?? '')
              call.hasOutput = true
              call.ok = false
              call.code = errorCode(null, text)
              call.error = text.slice(0, 300)
            }
            break
          }
          case 'finish':
            rec.finished = true
            break
          case 'error':
            rec.error = `stream error: ${JSON.stringify(c).slice(0, 300)}`
            break
        }
      }
      clearTimeout(deadline)
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err)
    }
    rec.ms = Date.now() - started
    log(`   << finished=${rec.finished} tools=[${rec.toolCalls.map((t) => t.name).join(',')}] ${rec.ms}ms`)
  }

  // Grace period: the transport's turn persist (projection + usage log) is
  // FIRE-AND-FORGET — exiting immediately after the stream closes kills the
  // process before the POST lands, so driver conversations would show zero
  // persisted messages/usage (a harness artifact, not a product bug).
  // The same wait lets the stream scan catch up with the last results.
  await new Promise((r) => setTimeout(r, 3000))

  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const areas = packsByCallId.get(call.callId)
      if (!areas) continue
      call.packs = [...areas]
      for (const a of areas) if (!turn.packs.includes(a)) turn.packs.push(a)
    }
  }

  const summary = { conversationId, eveSessionId, chatId, turns }
  console.log(JSON.stringify(summary, null, JSON_ONLY ? 0 : 2))
  if (OUT_FILE) writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2))
  process.exit(0)
}

/** callId → areas whose expertise pack rode that call's result, from the raw eve stream. */
const packsByCallId = new Map<string, Set<string>>()

/** Read a teed eve stream branch to its end, recording packs as they pass. Never throws. */
function scanEveStream(body: ReadableStream<Uint8Array>): void {
  void (async () => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        recordPacks(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    recordPacks(buf)
  })().catch(() => {
    // The stream closed or was aborted under us: whatever was read is kept.
  })
}

/** One NDJSON line: if a result in it carries `__expertise`, record its areas under the call's id. */
function recordPacks(line: string): void {
  if (!line.includes('__expertise')) return
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  const areas: string[] = []
  let callId: string | null = null
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const rec = node as Record<string, unknown>
    if (callId === null && typeof rec.callId === 'string') callId = rec.callId
    const blocks = rec.__expertise
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const area = b && typeof b === 'object' ? (b as { area?: unknown }).area : undefined
        if (typeof area === 'string' && !areas.includes(area)) areas.push(area)
      }
    }
    for (const [k, v] of Object.entries(rec)) if (k !== '__expertise') walk(v)
  }
  walk(event)
  if (areas.length === 0) return
  const key = callId ?? '(unknown)'
  const set = packsByCallId.get(key) ?? new Set<string>()
  for (const a of areas) set.add(a)
  packsByCallId.set(key, set)
}

main().catch((err) => {
  console.error('INFRA FAILURE:', err)
  process.exit(1)
})
