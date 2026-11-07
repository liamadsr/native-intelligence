/**
 * The chat-native tools (CHAT_NATIVE_TOOL_NAMES): only the main chat runs
 * them, through its own tool route with eve's ids. bots-v4 Phase A3 adds the
 * main agent's relay to the bots (send_bot_message, wait_for_bot_reply) to
 * delegate_work, and the plan's rule is "a bot never calls back into the main
 * agent or another bot". This file pins every surface at once:
 *
 *   skill runs (any config, inherit-all included), work runs (every origin, a
 *   resume, and a follow-up CHAT turn), a teammate chat (a bot's thread, a bot
 *   conversation, and so a loop run's chat, which takes the same ceiling), the
 *   live agent, the device ask, MCP (no execute), the persona picker, and the
 *   registries (classes, labels, schema twins).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolGuide } from '../tool-guides'
import { TOOL_FAMILIES } from '@/lib/packs/tool-families'
import { MAC_HOST_INSTRUCTIONS, macTalkBack } from '../../../../agents/chat-agent/lib/mac-instructions'
import {
  ALL_CATEGORY_IDS,
  CHAT_NATIVE_TOOL_NAMES,
  NON_CHAT_TOOL_NAMES,
  TOOL_REGISTRY_MAP,
  getMutatingToolNames,
  getToolSideEffect,
  isReadShapedToolName,
} from '../tool-registry'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import {
  ceilingForWorkRun,
  ceilingForWorkRunTurn,
  computeDraftingCeiling,
  computeWorkRunCeiling,
  type WorkRunRow,
} from '@/lib/agent-run/run-work-spec-rebuild'
import { EDITIONS, computeEditionToolCeiling } from '@/lib/editions'
import { computeLiveAgentCeiling, LIVE_AGENT_TURN_TYPES } from '@/lib/live-agent/ceiling'
import { LIVE_AGENT_READ_TOOLS } from '@/lib/live-agent/read-tool-names'
import { SURFACE_EXCLUDED_TOOLS, TEAMMATE_CHAT_EXCLUDED_TOOLS, composeTeammateChatCeiling } from '@/lib/chat/chat-ceiling'
import { createBotRelayTools, sendBotMessageSchema, waitForBotReplySchema } from '../tools/bot-relay'
import {
  LOCAL_AGENT_TOOL_NAMES,
  createLocalAgentTools,
  messageLocalAgentSchema,
  readLocalAgentSchema,
  startLocalAgentSchema,
  stopLocalAgentSchema,
} from '../tools/local-agent'
import { LOCAL_AGENT_MESSAGE_MAX_BYTES, LOCAL_AGENT_REQUEST_MAX_BYTES } from '@/lib/local-agent/store'
import { CLOUD_CODING_TOOL_NAMES, createCloudCodingTools, startCloudCodingRunSchema } from '../tools/cloud-coding'
import { GUEST_ANSWER_TOOL_NAMES, answerGuestSchema, createGuestAnswerTools } from '../tools/guest-answer'
import { AGENT_LINK_ASK_TOOL_NAMES, askAgentSchema, createAgentLinkAskTools } from '../tools/agent-link-ask'
import { createTools } from '../tools'

const NATIVE = [...CHAT_NATIVE_TOOL_NAMES]
const RELAY = ['send_bot_message', 'wait_for_bot_reply']
/** The local agents on the person's Mac (docs/plans/local-agents.md). */
const LOCAL = [...LOCAL_AGENT_TOOL_NAMES]
const LOCAL_MUTATORS = ['start_local_agent', 'message_local_agent', 'stop_local_agent']
const LOCAL_READS = ['local_agents', 'read_local_agent']
/** Their cloud counterpart (docs/plans/environments.md E2). */
const CLOUD = [...CLOUD_CODING_TOOL_NAMES]
/** The main agent's answer to a guest's ask (guest access, migration 429). */
const GUEST = [...GUEST_ANSWER_TOOL_NAMES]
/** The main agent asking a linked person's agent (agent links, migration 435). */
const LINK = [...AGENT_LINK_ASK_TOOL_NAMES]
const root = join(__dirname, '..', '..', '..', '..')
const WIDE = { allowed_side_effects: ['read', 'internal-write', 'automation-write', 'external-write', 'delete'], tool_allowlist: null }

describe('the chat-native set', () => {
  it('is start_helper, stop_helper, the two relay tools, the five local-agent tools, their cloud counterpart, answer_guest and ask_agent, each a registry tool in actions (no persona-grant migration)', () => {
    expect(NATIVE).toEqual(['start_helper', 'stop_helper', ...RELAY, ...LOCAL, ...CLOUD, ...GUEST, ...LINK])
    for (const name of NATIVE) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('actions')
  })

  it('send_bot_message is a write (it starts a bot turn that acts); wait_for_bot_reply only reads', () => {
    const mutating = getMutatingToolNames()
    expect(getToolSideEffect('send_bot_message')).toBe('automation-write')
    expect(mutating.has('send_bot_message')).toBe(true)
    expect(isReadShapedToolName('send_bot_message')).toBe(false)
    expect(getToolSideEffect('wait_for_bot_reply')).toBe('read')
    expect(mutating.has('wait_for_bot_reply')).toBe(false)
    expect(isReadShapedToolName('wait_for_bot_reply')).toBe(true)
  })

  it('the local agents: a start, a message and a stop are writes (each acts on the Mac); local_agents and read_local_agent only read', () => {
    const mutating = getMutatingToolNames()
    for (const name of LOCAL_MUTATORS) {
      expect([name, getToolSideEffect(name)]).toEqual([name, 'automation-write'])
      expect([name, mutating.has(name)]).toEqual([name, true])
      expect([name, isReadShapedToolName(name)]).toEqual([name, false])
    }
    for (const name of LOCAL_READS) {
      expect([name, getToolSideEffect(name)]).toEqual([name, 'read'])
      expect([name, mutating.has(name)]).toEqual([name, false])
      expect([name, isReadShapedToolName(name)]).toEqual([name, true])
    }
  })

  it('start_cloud_coding_run is a write (it files an action and starts a coding run)', () => {
    expect(CLOUD).toEqual(['start_cloud_coding_run'])
    expect(getToolSideEffect('start_cloud_coding_run')).toBe('automation-write')
    expect(getMutatingToolNames().has('start_cloud_coding_run')).toBe(true)
    expect(isReadShapedToolName('start_cloud_coding_run')).toBe(false)
  })

  it('answer_guest is outward (it texts the guest who asked), and its twin has no execute', () => {
    expect(GUEST).toEqual(['answer_guest'])
    expect(getToolSideEffect('answer_guest')).toBe('external-write')
    expect(getMutatingToolNames().has('answer_guest')).toBe(true)
    expect(isReadShapedToolName('answer_guest')).toBe(false)
    const id = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'
    expect(answerGuestSchema.safeParse({ ask_id: id, answer: 'Liam is free at 3.' }).success).toBe(true)
    expect(answerGuestSchema.safeParse({ ask_id: id, answer: 'No.', outcome: 'declined' }).success).toBe(true)
    expect(answerGuestSchema.safeParse({ ask_id: 'ask-1', answer: 'x' }).success).toBe(false)
    expect(answerGuestSchema.safeParse({ ask_id: id, answer: 'x'.repeat(601) }).success).toBe(false)
    const twin = createGuestAnswerTools() as Record<string, { execute?: unknown }>
    expect(Object.keys(twin)).toEqual(GUEST)
    expect(twin.answer_guest.execute).toBeUndefined()
  })

  it('ask_agent is outward (it messages another person\'s agent), names who or which exchange, and its twin has no execute', () => {
    expect(LINK).toEqual(['ask_agent'])
    expect(getToolSideEffect('ask_agent')).toBe('external-write')
    expect(getMutatingToolNames().has('ask_agent')).toBe(true)
    expect(isReadShapedToolName('ask_agent')).toBe(false)
    const id = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'
    expect(askAgentSchema.safeParse({ to: 'Dana', message: 'Is Dana free Thursday afternoon?' }).success).toBe(true)
    expect(askAgentSchema.safeParse({ exchange_id: id, message: 'And Friday?' }).success).toBe(true)
    expect(askAgentSchema.safeParse({ message: 'Hi' }).success).toBe(false)
    expect(askAgentSchema.safeParse({ exchange_id: 'x', message: 'Hi' }).success).toBe(false)
    expect(askAgentSchema.safeParse({ to: 'Dana', message: 'x'.repeat(1001) }).success).toBe(false)
    const twin = createAgentLinkAskTools() as Record<string, { execute?: unknown }>
    expect(Object.keys(twin)).toEqual(LINK)
    expect(twin.ask_agent.execute).toBeUndefined()
  })

  it('its schema: exactly one of a project id or an owner/repo, a request, an optional title and environment id; no path, no branch', () => {
    const id = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'
    expect(startCloudCodingRunSchema.safeParse({ project_id: id, request: 'Fix the export' }).success).toBe(true)
    expect(startCloudCodingRunSchema.safeParse({ repo: 'acme/core', request: 'Fix it', title: 'Export', environment_id: id }).success).toBe(true)
    expect(startCloudCodingRunSchema.safeParse({ request: 'Fix it' }).success).toBe(false)
    expect(startCloudCodingRunSchema.safeParse({ project_id: id, repo: 'acme/core', request: 'Fix it' }).success).toBe(false)
    expect(startCloudCodingRunSchema.safeParse({ repo: 'https://github.com/acme/core', request: 'Fix it' }).success).toBe(false)
    expect(startCloudCodingRunSchema.safeParse({ project_id: 'core', request: 'Fix it' }).success).toBe(false)
    expect(startCloudCodingRunSchema.safeParse({ project_id: id, request: '  ' }).success).toBe(false)
    expect(Object.keys(startCloudCodingRunSchema.shape).sort()).toEqual(['environment_id', 'project_id', 'repo', 'request', 'title'])
    const twin = createCloudCodingTools() as Record<string, { execute?: unknown }>
    expect(Object.keys(twin)).toEqual(CLOUD)
    expect(twin.start_cloud_coding_run.execute).toBeUndefined()
  })

  it('the local-agent schemas: ids are uuids, a request and a message within the server’s UTF-8 byte caps, a mode and a policy from two each', () => {
    const id = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'
    expect(startLocalAgentSchema.safeParse({ folder_id: id, request: 'Take a look at this repo' }).success).toBe(true)
    expect(startLocalAgentSchema.safeParse({ folder_id: id, request: 'x', mode: 'edit' }).success).toBe(true)
    expect(startLocalAgentSchema.safeParse({ folder_id: id, request: 'x', mode: 'write' }).success).toBe(false)
    expect(startLocalAgentSchema.safeParse({ folder_id: 'dial8-website', request: 'x' }).success).toBe(false)
    expect(startLocalAgentSchema.safeParse({ folder_id: id, request: '   ' }).success).toBe(false)
    // The caps are bytes: exactly at the cap passes, one ASCII byte over fails, and
    // 4-byte emoji fail well under the cap in characters, with a message to act on.
    expect(startLocalAgentSchema.safeParse({ folder_id: id, request: 'a'.repeat(LOCAL_AGENT_REQUEST_MAX_BYTES) }).success).toBe(true)
    expect(startLocalAgentSchema.safeParse({ folder_id: id, request: 'a'.repeat(LOCAL_AGENT_REQUEST_MAX_BYTES + 1) }).success).toBe(false)
    const emoji = startLocalAgentSchema.safeParse({ folder_id: id, request: '🙂'.repeat(LOCAL_AGENT_REQUEST_MAX_BYTES / 4 + 1) })
    expect(emoji.success).toBe(false)
    expect(emoji.error?.issues.map((i) => i.message).join(' ')).toContain(`longer than ${LOCAL_AGENT_REQUEST_MAX_BYTES} bytes of UTF-8`)
    expect(messageLocalAgentSchema.safeParse({ session_id: id, text: 'é'.repeat(LOCAL_AGENT_MESSAGE_MAX_BYTES / 2) }).success).toBe(true)
    const accents = messageLocalAgentSchema.safeParse({ session_id: id, text: 'é'.repeat(LOCAL_AGENT_MESSAGE_MAX_BYTES / 2 + 1) })
    expect(accents.success).toBe(false)
    expect(accents.error?.issues.map((i) => i.message).join(' ')).toContain('Shorten it')
    // No path, no command: the twin has no field for one.
    expect(Object.keys(startLocalAgentSchema.shape).sort()).toEqual(['folder_id', 'mode', 'request'])
    expect(messageLocalAgentSchema.safeParse({ session_id: id, text: 'stick to src/', policy: 'queue' }).success).toBe(true)
    expect(messageLocalAgentSchema.safeParse({ session_id: id, text: 'hi', policy: 'now' }).success).toBe(false)
    expect(readLocalAgentSchema.safeParse({ session_id: id, after_id: 12 }).success).toBe(true)
    expect(readLocalAgentSchema.safeParse({ session_id: id, after_id: -1 }).success).toBe(false)
    expect(stopLocalAgentSchema.safeParse({ session_id: 'nope' }).success).toBe(false)
  })

  it('the schema twins have no execute, so no generic surface can run them', () => {
    const twins = createBotRelayTools()
    for (const name of RELAY) expect((twins as Record<string, { execute?: unknown }>)[name].execute, name).toBeUndefined()
    const local = createLocalAgentTools() as Record<string, { execute?: unknown }>
    expect(Object.keys(local)).toEqual(LOCAL)
    for (const name of LOCAL) expect(local[name].execute, name).toBeUndefined()
    const all = createTools('00000000-0000-0000-0000-000000000000', {} as never, '00000000-0000-0000-0000-000000000000') as Record<string, { execute?: unknown }>
    for (const name of NATIVE) {
      expect(all[name], name).toBeDefined()
      expect(all[name].execute, name).toBeUndefined()
    }
  })

  it('the schemas: an item id or a bot id (A4) and a message (capped at 4,000); a relay id and an optional wait of at most 240 s', () => {
    expect(sendBotMessageSchema.safeParse({ item_id: 'x', message: 'hi' }).success).toBe(true)
    expect(sendBotMessageSchema.safeParse({ bot_id: '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a', message: 'hi' }).success).toBe(true)
    expect(sendBotMessageSchema.safeParse({ bot_id: 'Writer', message: 'hi' }).success).toBe(false)
    expect(sendBotMessageSchema.safeParse({ item_id: 'x', message: '   ' }).success).toBe(false)
    expect(sendBotMessageSchema.safeParse({ item_id: 'x', message: 'a'.repeat(4001) }).success).toBe(false)
    // Neither is the relay's to refuse (a refinement would not reach the model's JSON schema).
    expect(sendBotMessageSchema.safeParse({ message: 'hi' }).success).toBe(true)
    expect(waitForBotReplySchema.safeParse({ relay_id: '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a' }).success).toBe(true)
    expect(waitForBotReplySchema.safeParse({ relay_id: 'nope' }).success).toBe(false)
    expect(waitForBotReplySchema.safeParse({ relay_id: '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a', max_wait_seconds: 241 }).success).toBe(false)
  })
})

describe('nowhere but the main chat', () => {
  it('skill runs: no config grants one, and inherit-all (NON_CHAT_TOOL_NAMES) leaves them out', () => {
    for (const name of NATIVE) expect(NON_CHAT_TOOL_NAMES, name).not.toContain(name)
    for (const config of [{ enabled_tools: [...ALL_CATEGORY_IDS] }, { enabled_tools: ['actions'] }, null]) {
      for (const mode of ['act', 'report'] as const) {
        const ceiling = computeSkillCeiling(config, mode, true)
        for (const name of NATIVE) expect(ceiling?.has(name) ?? false, `${name} ${mode}`).toBe(false)
      }
    }
  })

  it('work runs: every origin, the drafting profile, a teammate admitting every class (wait_for_bot_reply is a read)', () => {
    const ceilings = [
      computeWorkRunCeiling(),
      computeDraftingCeiling(),
      ...[null, 'user', 'attempt', 'chat', 'delegation', 'loop'].map((origin) => ceilingForWorkRun(origin, WIDE, null)),
    ]
    for (const c of ceilings) for (const name of NATIVE) expect(c.has(name), name).toBe(false)
  })

  it('a work run’s turns: its own token, a resume, and a follow-up CHAT turn (the run chat) hold none', async () => {
    const run: WorkRunRow = { id: 'run-1', kind: 'workspace', origin: 'user', ai_team_member_id: 'tm-1', teammate: null }
    for (const claims of [{ workspaceId: 'ws' }, { workspaceId: 'ws', resume: true as const }, { workspaceId: 'ws', chat: true as const }]) {
      const c = await ceilingForWorkRunTurn(teammateClient(), run, claims)
      for (const name of NATIVE) expect(c.has(name), `${name} ${JSON.stringify(claims)}`).toBe(false)
    }
  })

  it('a teammate chat (its thread, a bot conversation, a loop run’s chat): never, whatever its bounds', () => {
    for (const name of NATIVE) expect(TEAMMATE_CHAT_EXCLUDED_TOOLS.has(name), name).toBe(true)
    const full = computeEditionToolCeiling(EDITIONS.full)
    for (const frontsOnly of [false, true]) {
      const c = composeTeammateChatCeiling(full, { ...WIDE, agentConfig: null, frontsOnly }, ['send_bot_message', 'wait_for_bot_reply', 'start_helper', 'stop_helper', ...LOCAL])
      for (const name of NATIVE) expect(c.has(name), `${name} frontsOnly=${frontsOnly}`).toBe(false)
    }
  })

  it('the live agent: no turn type or persona reaches one, and its READ allowlist holds none', () => {
    for (const name of NATIVE) expect(LIVE_AGENT_READ_TOOLS.has(name), name).toBe(false)
    for (const turnType of LIVE_AGENT_TURN_TYPES) {
      for (const agentConfig of [null, { enabled_tools: [...ALL_CATEGORY_IDS] }]) {
        const { ceiling } = computeLiveAgentCeiling({ turnType, assistOnly: false, agentConfig })
        for (const name of NATIVE) expect(ceiling.has(name), `${turnType} ${name}`).toBe(false)
      }
    }
  })

  it('the device ask excludes every one structurally', () => {
    for (const name of NATIVE) expect(SURFACE_EXCLUDED_TOOLS.device_ask.has(name), name).toBe(true)
  })
})

describe('the registries', () => {
  it('the chat’s friendly labels name the relay and local-agent tools (prompt-kit/tool.tsx)', () => {
    const labels = readFileSync(join(root, 'src/components/prompt-kit/tool.tsx'), 'utf8')
    for (const name of [...RELAY, ...LOCAL, ...CLOUD]) expect(labels, name).toMatch(new RegExp(`\\b${name}: '`))
  })

  it('the chat agent knows when to start a local agent and how to follow one up, and a home turn only answers its question', () => {
    const md = readFileSync(join(root, 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
    // The standing part: where work runs, and what a local agent is, naming its tools.
    const from = md.indexOf('## Where work runs')
    expect(from).toBeGreaterThan(-1)
    const where = md.slice(from, md.indexOf('## Background updates'))
    for (const name of LOCAL.filter((n) => n !== 'local_agents')) expect(where, name).toContain(`\`${name}\``)
    expect(where).toContain('`start_cloud_coding_run`')
    expect(where).toContain('only when they ask in words')
    expect(where).toContain('ask where to run before you start work')
    expect(where).toContain('A local agent is you, the Dial8 agent')
    // How rides the tools themselves (src/lib/ai/tool-guides.ts).
    const guides = [...LOCAL.map((n) => toolGuide(n) ?? ''), TOOL_FAMILIES.find((f) => f.key === 'local_agents')!.guide].join(' ')
    expect(guides).toContain('One agent per folder')
    expect(guides).toContain('`FOLDER_BUSY`')
    expect(guides).toContain('`cloud_fallback`')
    expect(guides).toContain('never paste the transcript')
    expect(guides).toContain('never paste it')
    expect(guides).toContain('`steer` (the default)')
    // The Mac body's own part is the Mac's alone (lib/mac-instructions.ts), never the cloud agent's prompt.
    expect(md).not.toContain("When you are Dial8 on the person's Mac")
    const mac = `${MAC_HOST_INSTRUCTIONS}\n\n${macTalkBack(new Set(['message_teammate', 'report_to_person']))}`
    for (const name of ['message_teammate', 'report_to_person', 'finish']) expect(mac, name).toContain(`\`${name}\``)
    expect(mac).toContain('past a few an hour it is refused')
    expect(mac).toContain('happens only after the person says yes on their Mac')
    // The turn context names the environment rider, and a background update keeps its one exception.
    expect(md).toContain('`environment` is this chat\'s environment')
    expect(md).not.toContain('`folders` section')
    const updates = md.slice(md.indexOf('## Background updates'))
    expect(updates).toContain('answer it with `message_local_agent`')
    expect(updates).toContain('never start one')
  })

  it('the chat agent knows how a message reaches an agent, beside the other ways to talk to one', () => {
    const md = readFileSync(join(root, 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
    expect(md.slice(md.indexOf('## Your agents'))).toContain('`send_bot_message`')
    const guide = toolGuide('send_bot_message') ?? ''
    expect(guide).toContain('call `wait_for_bot_reply` with its `relay_id`; never send the message again')
    expect(TOOL_FAMILIES.find((f) => f.key === 'agents')!.guide).toContain("The person can also talk to an agent on its page, with its chat on the left.")
  })

  it('the persona picker hides chat-native tools', () => {
    const picker = readFileSync(join(root, 'src/app/account/(dashboard)/views/agents/item-dialogs.tsx'), 'utf8')
    expect(picker).toMatch(/!isChatNativeTool\(t\.name\)/)
  })

  it('the chat tool route states its maxDuration (300 s) and refuses the relay on a teammate or surface token', () => {
    const route = readFileSync(join(root, 'src/app/api/internal/chat/tool/route.ts'), 'utf8')
    expect(route).toMatch(/export const maxDuration = 300\b/)
    expect(route).toMatch(/RELAY_TOOLS\.has\(toolName\) && \(claims\.teammateId \|\| claims\.surface\)/)
    // The local agents are refused there too, and their mutators are reviewed as chat-native (refused, never carded):
    // the reviewed set lives in the run the route shares with the Mac body's (chat-tool-dispatch.ts).
    const dispatch = readFileSync(join(root, 'src/lib/chat/chat-tool-dispatch.ts'), 'utf8')
    const relaySet = route.slice(route.indexOf('const RELAY_TOOLS'), route.indexOf('])', route.indexOf('const RELAY_TOOLS')))
    const reviewed = dispatch.slice(dispatch.indexOf('const CHAT_NATIVE_REVIEWED'), dispatch.indexOf('])', dispatch.indexOf('const CHAT_NATIVE_REVIEWED')))
    expect(reviewed).toContain('CHAT_NATIVE_REVIEWED')
    for (const name of LOCAL) expect(relaySet, name).toContain(`'${name}'`)
    for (const name of LOCAL_MUTATORS) expect(reviewed, name).toContain(`'${name}'`)
    for (const name of LOCAL_READS) expect(reviewed, name).not.toContain(`'${name}'`)
  })
})

/** A service-client double: the run's bot is a system teammate, fronting no loop. */
function teammateClient() {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.limit = () => c
    c.maybeSingle = async () => ({ data: table === 'ai_team_member' ? { system_key: 'triage', role: null } : null, error: null })
    c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
    return c
  }
  return { from: (t: string) => chain(t) } as never
}
