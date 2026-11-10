import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { extractTargetedSessionId } from '../auth'
import { buildTurnUsageReport, emptyTurnUsage, foldTurnUsageEvent, type TurnUsageAcc } from '../turn-usage'

/**
 * Evidence for quick helpers (docs/plans/helpers-spike.md, A4 slice 3), pinned
 * on eve's compiled runtime. Each pin fails when an eve bump changes the
 * behaviour the build rests on, and the verdict must then be re-checked.
 *
 * Re-checked on eve 0.79.1 (from 0.66.3). What changed:
 *   - eve no longer opens the parent's sandbox at dispatch. A root copy (the
 *     built-in `agent`) or a child whose sandbox is `parent` SHARES the
 *     parent's sandbox session; a declared node without one does not. The
 *     build never used the root copy (its `agent` slot is disabled), so the S0
 *     root-copy pins are retired and the declared-helper rule is pinned instead.
 *   - background tasks are gone (0.69): the `helpers` tool is an `execute`
 *     workflow tool, so the turn waits for it, and with `agent` off and the
 *     helper declared `tool: false` the chat agent gets no `eve__task_*` tools.
 *   - `ctx.agent(name)` returns a session (0.69): `send()` then `result()`.
 *   - a steering message now aborts the waited call's `ctx.abortSignal` as an
 *     interrupt (0.69); the body ignores that and keeps waiting (lib/helpers.ts
 *     isSteerInterrupt), so a steer still waits for the helpers.
 *   - eve 0.74 derives a workflow tool's id from ONE root (the agent root), so
 *     the 0.66.3 alias (registerHelpersWorkflowAlias) is deleted.
 */

const repoRoot = resolve(__dirname, '../../../..')
const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
const dist = (rel: string) => readFileSync(join(eveRoot, 'dist/src', rel), 'utf8')

describe('helpers — the installed eve is the version these pins were re-checked on', () => {
  it('is eve 0.79.1', () => {
    expect(JSON.parse(readFileSync(join(eveRoot, 'package.json'), 'utf8')).version).toBe('0.79.1')
  })
})

describe('helpers — only a root copy or a `parent`-sandbox child shares the parent sandbox', () => {
  it('a child shares the parent sandbox session only for a `parent` sandbox or a root copy (selfAgent)', () => {
    expect(dist('subagents/tool.js')).toContain(
      'return(e.graph?.nodesByNodeId.get(t.nodeId)?.sandboxRegistry.sandbox?.definition.kind===`parent`||e.selfAgent)&&(s.sandboxState!==void 0&&(u.parentSandboxState=s.sandboxState),u.sandboxSessionId=e.sandboxSessionId??s.sessionId)',
    )
    // selfAgent is the runtime root copy; a declared helper is a compiled node.
    expect(dist('execution/agent-sessions/steps.js')).toContain('selfAgent:i.source.type===`runtime`')
  })

  it('nothing opens a sandbox at dispatch any more (0.66.3 called SandboxKey.get() on the parent first)', () => {
    for (const rel of ['subagents/tool.js', 'execution/agent-sessions/steps.js', 'execution/agent-sessions/session.js']) {
      expect(dist(rel), rel).not.toContain('require(SandboxKey).get()')
    }
  })

  it('the chat agent runs on the framework default sandbox (Vercel Sandbox in production)', () => {
    expect(existsSync(join(repoRoot, 'agents/chat-agent/sandbox.ts'))).toBe(false)
    expect(existsSync(join(repoRoot, 'agents/chat-agent/sandbox'))).toBe(false)
    expect(dist('framework/sources/modules/sandbox.js')).toContain(
      'const environment=DefaultSandbox.environment();var sandbox_default=defineSandbox(()=>environment.open())',
    )
  })

  it('a declared subagent with its own sandbox costs a build-time template per node', () => {
    expect(dist('execution/sandbox/prewarm.js')).toContain(
      'return n.definition.kind===`parent`?[]:[{...n,definition:n.definition,nodeId:e}]',
    )
  })

  it('the helper is a declared node (not the root copy) with no `parent` sandbox', () => {
    const helperRoot = join(repoRoot, 'agents/chat-agent/subagents/helper')
    expect(existsSync(join(helperRoot, 'agent.ts'))).toBe(true)
    expect(existsSync(join(helperRoot, 'sandbox.ts'))).toBe(false)
    expect(existsSync(join(helperRoot, 'sandbox'))).toBe(false)
    const config = readFileSync(join(helperRoot, 'agent.ts'), 'utf8').split('export default defineAgent(')[1]
    expect(config).not.toMatch(/sandbox/)
    expect(readFileSync(join(repoRoot, 'agents/chat-agent/lib/helpers.ts'), 'utf8')).toContain("export const HELPER_AGENT_NAME = 'helper'")
  })
})

describe('helpers — credentials carry over', () => {
  it('a workflow run’s agent sessions run as the call’s principal', () => {
    // The run's auth is the call's session auth, and every send carries it.
    expect(dist('execution/tools/workflow/body.js')).toContain('i={agentContext:e.agentContext,asks:n,auth:e.session.auth,')
    expect(dist('execution/agent-sessions/session.js')).toContain('await this.#u({auth:this.#n.auth,message:e,')
  })

  it('a child session starts with the dispatching context’s auth', () => {
    expect(dist('subagents/tool.js')).toContain('runInput:{adapter:{kind:SUBAGENT_ADAPTER_KIND,state:u},auth:n,')
  })
})

describe('helpers — metering', () => {
  it('a run’s child usage also lands in eve’s session totals, which the meter must never read', () => {
    expect(dist('execution/agent-sessions/usage.js')).toContain(
      'function countRunUsage(e,t,n){return setTurnUsageState(e,accumulateSessionUsage(',
    )
  })

  it('the meter bills the parent’s own model steps only, never delegated usage in turn/session totals', () => {
    // Each helper session bills its own turns (its own session id, so its own
    // idempotency key). eve 0.70+ puts the delegated usage into the parent's
    // turn.waiting / session.waiting `usage`; if the parent meter ever summed
    // those, every helper would be billed twice.
    const T = 'turn_1'
    const ev = (type: string, data: Record<string, unknown>, sec: number) => ({
      type,
      data: { sequence: 1, turnId: T, ...data },
      meta: { id: `evt_${type}_${sec}`, at: `2026-10-15T10:00:0${sec}.000Z` },
    })
    const events = [
      ev('turn.started', {}, 0),
      ev('step.started', { modelId: 'deepseek/deepseek-v4-flash', stepIndex: 0 }, 1),
      ev('step.completed', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 } }, 2),
      ev('agent.started', { callId: 'c1', name: 'helper', sessionId: 'wrun_child', streamPath: '/eve/v1/session/wrun_child/stream' }, 3),
      ev('turn.completed', {}, 4),
      ev('session.waiting', { continuationToken: 'x', wait: 'next-user-message', usage: { inputTokens: 9100, outputTokens: 910 } }, 5),
    ]
    const acc = events.reduce<TurnUsageAcc>((a, e) => foldTurnUsageEvent(a, e), emptyTurnUsage())
    const report = buildTurnUsageReport(acc, { sessionId: 'parent', turnId: T, outcome: 'completed', endedAt: null })
    expect(report).toMatchObject({ inputTokens: 100, outputTokens: 10, steps: 1 })
  })
})

describe('helpers — no task tools, and the turn waits for the blocking call', () => {
  it('only a non-`execute` entry point starts tasks, and task tools come only with a visible task-starting agent tool', () => {
    expect(dist('execution/tasks/tool-entry-point.js')).toContain('function startsTasks(e){return entryPointOf(e)!==`execute`}')
    expect(dist('execution/catalog/step-catalog.js')).toContain('agentTools.values()].some(e=>visible(e)&&startsTasks(e))')
    const tool = readFileSync(join(repoRoot, 'agents/chat-agent/tools/helpers.ts'), 'utf8')
    expect(tool).toMatch(/defineWorkflowTool\(\{[\s\S]*\n {2}execute,\n\}\)/)
    expect(tool).not.toMatch(/\btask\(|\bserve\(/)
  })
})

describe('helpers — progress, children and their streams', () => {
  it('a blocking workflow tool’s yield is published as action.partial for the pending call', () => {
    expect(dist('execution/tools/workflow/apply-run-messages-step.js')).toContain(
      'function workflowToolRunReportEvent(e,t){return createActionPartialEvent({result:createRuntimeToolResultFromValue({callId:e.callId,output:t,toolName:e.toolName})',
    )
    // The transport projects it through the shared reducer it runs
    // (src/lib/chat/eve-turn-parts.ts, which the server's home-turn writer runs too).
    const transport = readFileSync(join(repoRoot, 'src/lib/chat/eve/eve-chat-transport.ts'), 'utf8')
    expect(transport).toContain('applyEveTurnEvent(turn, event, {')
    const reducer = readFileSync(join(repoRoot, 'src/lib/chat/eve-turn-parts.ts'), 'utf8')
    expect(reducer).toContain("case 'action.partial': {")
    expect(reducer).toContain('preliminary: true,')
  })

  it('the sessions a run opens end when the run finishes, which cancels a helper still running', () => {
    expect(dist('execution/tools/workflow/workflow.js')).toContain('finally{await i.close()}')
    expect(dist('execution/agent-sessions/session.js')).toContain(
      'close:async()=>{n.length!==0&&await endAgentSessionsStep({sessions:n})}',
    )
  })

  it('a local child streams on its own session route, which the ownership ACL refuses', () => {
    expect(dist('protocol/message.js')).toContain('streamPath:createEveSessionStreamRoutePath(e.sessionId)')
    // The ACL checks the CHILD's id, and no chat_conversations row registers a
    // child, so following an agent.started stream would get a 403 from this channel.
    const req = new Request('https://nativeintelligence.dev/eve/chat-agent/v1/session/wrun_child123/stream')
    expect(extractTargetedSessionId(req)).toBe('wrun_child123')
  })
})

describe('helpers — a steer waits for the blocking tool (lib/helpers.ts isSteerInterrupt)', () => {
  const turn = () => dist('execution/session/turn.js')
  const body = () => dist('execution/tools/workflow/body.js')

  it('a steer interrupts the waited workflow calls once, and the turn keeps waiting for their results', () => {
    expect(turn()).toContain(
      'if(c.kind===`steering`){n||await this.interruptWaitedWorkflowCalls(e.pendingCallIds,t),n=!0;continue}',
    )
    // The wait ends early only on the turn's own cancel.
    expect(turn()).toContain('c=await e.turn.nextRuntimeEvent(s);if(c===`cancelled`)return c;')
  })

  it('an interrupt aborts only the body signal, with the reason isSteerInterrupt reads; a cancel aborts the run too', () => {
    expect(body()).toContain('case`interrupt`:this.body.abort(new WorkflowToolRunInterruptedError);return;')
    expect(body()).toContain(
      'case`cancel`:case`end`:this.asks.cancelAll(),this.run.abort(new WorkflowToolRunCancelledError(e.reason)),this.body.abort(this.run.signal.reason);return;',
    )
    expect(body()).toContain('this.name=`WorkflowToolRunInterruptedError`')
    expect(body()).toContain('this.name=`WorkflowToolRunCancelledError`')
  })
})

describe('helpers — Stop (Send now) cancels the tool’s run and its helpers', () => {
  it('cancelling a turn cancels its blocking workflow runs', () => {
    const step = dist('execution/cancel-descendant-turns-step.js')
    expect(step).toContain('t=getBlockingWorkflowToolRuns(n.state,')
    expect(step).toContain('cancelWorkflowToolRun(e.address,{kind:`cancel`,reason:`The turn that called the tool was cancelled.`})')
  })
})

describe('helpers — eve 0.74+ derives a workflow tool’s id from one root (the 0.66.3 alias is gone)', () => {
  // The live failure on 0.66.3: "Tool "helpers" is not registered as a workflow
  // in this deployment (workflow//./agents/chat-agent/tools/helpers//execute)":
  // the compile step took the id from the repo root, the bundle from the agent
  // root. eve 0.74 passes the agent root to the compile loader too, so the
  // manifest says workflow//./tools/helpers//execute, the id the bundle registers.
  it('the compile step loads an application binding from the agent root', () => {
    expect(dist('compiler/load-binding-namespace.js')).toContain('appRoot:e.binding.owner.kind===`application`?e.appRoot:void 0')
    expect(dist('internal/authored-module-loader.js')).toContain('createAuthoredWorkflowDirectivePlugin({appRoot:t.appRoot??n})')
  })

  it('the workflow bundle derives it from the agent root too, and the run looks the body up by the manifest id', () => {
    expect(dist('internal/workflow-bundle/builder.js')).toContain('projectRoot:e.appRoot')
    expect(dist('execution/tools/workflow/body.js')).toContain('readRegisteredWorkflow(e.workflowId)')
  })

  it('lib/helpers.ts and the tool carry no workflow-registry alias', () => {
    for (const rel of ['agents/chat-agent/lib/helpers.ts', 'agents/chat-agent/tools/helpers.ts']) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, rel).not.toContain('__private_workflows')
      expect(src, rel).not.toContain('registerHelpersWorkflowAlias')
    }
  })
})
