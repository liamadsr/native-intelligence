import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * What every main chat send carries:
 *
 * 1. Its own `systemContext`. The eve transport reads ONLY the send's own
 *    body — there is no transport-level body — so EVERY send builds one (the panel's context: a call going on rides in
 *    it as `onCallCaptureId`).
 * 2. Never a live meeting's id: the main chat is the main agent's, and a
 *    call's live agent talks in its own chat (components/live-chat, one-chat
 *    Slice 3). No send names `liveCaptureId`, and there is no live framing.
 * 3. The active agent. The transport reads `agentId` from the send's OWN body
 *    only; a send without it makes an eve mint drop its tool boundary.
 * 4. No model and no thinking level: the server picks the model per turn.
 *
 * ChatPanel can't be mounted with a real transport in a unit test, so this
 * pins the sends in the source, the way live-agent-card-placement.test.ts pins
 * the card.
 */

const source = readFileSync(
  join(process.cwd(), 'src/app/account/(dashboard)/chat/chat-panel.tsx'),
  'utf8',
)
const file = ts.createSourceFile('chat-panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText(file) === name) return p.initializer
  }
  return undefined
}

/**
 * `turnBody`'s returned object literal: the composer's one send body. The
 * composer's dispatchTurn spreads it into its send, and a steer (UI-2) posts the
 * same body, so the two can't drift; the checks below read it in that send's
 * place.
 */
function turnBodyLiteral(): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'turnBody' && node.body) {
      for (const stmt of node.body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
          found = stmt.expression
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** A body that spreads `turnBody(...)` (the composer's send). */
function spreadsTurnBody(body: ts.ObjectLiteralExpression): boolean {
  return body.properties.some(
    (p) =>
      ts.isSpreadAssignment(p) &&
      ts.isCallExpression(p.expression) &&
      p.expression.expression.getText(file) === 'turnBody',
  )
}

/** The `body` of every `sendMessage(msg, { body })`; one spreading `turnBody(...)` reads as turnBody's literal. */
function sendBodies(): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'sendMessage') {
      const opts = node.arguments[1]
      const body = opts && ts.isObjectLiteralExpression(opts) ? prop(opts, 'body') : undefined
      if (body && ts.isObjectLiteralExpression(body)) found.push(spreadsTurnBody(body) ? (turnBodyLiteral() ?? body) : body)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Every `sendMessage(...)` call, whatever its arguments look like. */
function sendCalls(): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'sendMessage') found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Every place the `sendMessage` identifier is used as a VALUE other than being
 * called: an alias (`const send = sendMessage`), a prop (`onSend={sendMessage}`),
 * an argument. Allowed: the useChat destructuring that declares it, and hook
 * dependency arrays. Any other use is a send path the body checks cannot see.
 */
function sendMessageValueUses(): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === 'sendMessage') {
      const parent = node.parent
      const isCallee = ts.isCallExpression(parent) && parent.expression === node
      // Declared: destructured, or the one wrapper that stamps each send's time (message-time.ts).
      const isDeclaration = ts.isBindingElement(parent) || (ts.isVariableDeclaration(parent) && parent.name === node)
      const isDep = ts.isArrayLiteralExpression(parent)
      if (!isCallee && !isDeclaration && !isDep) out.push(`chat-panel.tsx:${lineOf(node)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** The `systemContext` of every send body that builds its own. */
function sendSystemContexts(): ts.Expression[] {
  return sendBodies()
    .map((body) => prop(body, 'systemContext'))
    .filter((ctx): ctx is ts.Expression => ctx !== undefined)
}

const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1

describe('every main chat send builds its own systemContext, never a live meeting’s', () => {
  it('finds the sends that build their own systemContext (control)', () => {
    // Typed message (and a skill chip's, through it), a starter,
    // chat-about-proposal, Scout, Find email, Mail's Reply. Fewer means the
    // matcher below has gone blind.
    expect(sendSystemContexts().length).toBeGreaterThanOrEqual(6)
  })

  it('names no live meeting: no liveCaptureId, no liveTurnContext, no live framing', () => {
    expect(source).not.toMatch(/\bliveCaptureId\b/)
    expect(source).not.toMatch(/\bliveTurnContext\b/)
    expect(source).not.toMatch(/LIVE_MEETING_SYSTEM_FRAMING|LIVE_CHAT_REPLY_NOTE|buildLiveTurnContext/)
  })

  it('EVERY sendMessage call passes a literal { body } (none can slip past the checks below)', () => {
    // sendBodies() only sees calls whose options are an object literal with a
    // literal body; a bare sendMessage({ text }) or options from a variable would
    // be invisible to it and pass vacuously — and lose its context + agentId.
    const calls = sendCalls()
    expect(calls.length).toBeGreaterThanOrEqual(6)
    expect(sendBodies().length).toBe(calls.length)
  })

  it('a send that spreads turnBody adds nothing to it but the steer id', () => {
    // The composer's send reads as turnBody's literal above, so anything it
    // added beside the spread would escape the checks; only steerId may.
    expect(turnBodyLiteral()).toBeDefined()
    const extras: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'sendMessage') {
        const opts = node.arguments[1]
        const body = opts && ts.isObjectLiteralExpression(opts) ? prop(opts, 'body') : undefined
        if (body && ts.isObjectLiteralExpression(body) && spreadsTurnBody(body)) {
          for (const p of body.properties) {
            if (ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression) && p.expression.expression.getText(file) === 'turnBody') continue
            if (!/\bsteerId\b/.test(p.getText(file))) extras.push(`chat-panel.tsx:${lineOf(p)}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(extras).toEqual([])
  })

  it('sendMessage is never aliased or passed on (only called, declared, or listed as a dep)', () => {
    expect(sendMessageValueUses()).toEqual([])
  })

  it('EVERY send builds a systemContext — there is no transport body to fall back on', () => {
    const missing = sendBodies()
      .filter((body) => prop(body, 'systemContext') === undefined)
      .map((body) => `chat-panel.tsx:${lineOf(body)}`)
    expect(missing).toEqual([])
  })

  it('constructs no DefaultChatTransport (eve is the only cloud chat runtime)', () => {
    expect(source).not.toMatch(/new DefaultChatTransport\b/)
    expect(source).not.toMatch(/NEXT_PUBLIC_CHAT_EVE_RUNTIME/)
  })
})

describe('every chat send names the active agent', () => {
  it('finds every send with a body (control)', () => {
    expect(sendBodies().length).toBeGreaterThanOrEqual(6)
  })

  it('puts agentId in each send body — the transport reads it from there only', () => {
    const missing = sendBodies()
      .filter((body) => !body.properties.some((p) => /\bagentId\b/.test(p.getText(file))))
      .map((body) => `chat-panel.tsx:${lineOf(body)}`)
    expect(missing).toEqual([])
  })
})

describe('no chat send carries a model or a thinking level', () => {
  it('names neither in any send body: the server picks the model per turn', () => {
    // The eve transport computes the routing signals from the message itself;
    // a body naming a model (or spreading a helper that did) would be a picker
    // coming back through the side door.
    const named = sendBodies()
      .filter(
        (body) =>
          prop(body, 'model') !== undefined ||
          prop(body, 'thinking') !== undefined ||
          body.properties.some((p) => ts.isSpreadAssignment(p) && /model|thinking/i.test(p.expression.getText(file))),
      )
      .map((body) => `chat-panel.tsx:${lineOf(body)}`)
    expect(sendBodies().length).toBeGreaterThanOrEqual(6)
    expect(named).toEqual([])
  })

  it('keeps no model state: no picker hook, no turnModelBody', () => {
    expect(source).not.toMatch(/useComposerModel|turnModelBody|selectedModel|thinkingByModel/)
  })
})
