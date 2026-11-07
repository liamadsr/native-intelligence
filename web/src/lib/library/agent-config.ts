/**
 * The ONE definition of a recipe's `agent_config` (skills and personas) and
 * the policy for writing it — Sequence step 1 of
 * docs/plans/agent-orchestration-product.md (the D.1 lockdown).
 *
 * Before this module the config lived in three shapes: the persisted
 * `AgentConfig` type (src/lib/types/library.ts, no contract keys), the chat
 * tool's zod schema (a plain `z.object` that silently STRIPPED
 * `output_contract` / `preconditions` / `capture_mode` and typed
 * `response_style` as a string), and `SkillAgentConfig` in run-skill.ts (the
 * only place the contract keys were named). A model rewriting a skill's config
 * through chat therefore turned a verdict skill into a prose one and widened
 * its tools in the same call.
 *
 * Rules, enforced by the HTTP routes (the only writers left):
 *   - `parseAgentConfig` validates WITHOUT stripping: unknown keys are an error,
 *     every known key is preserved, `response_style` accepts the persisted
 *     object shape and the legacy string.
 *   - The three CONTRACT keys — `output_contract`, `preconditions`,
 *     `capture_mode` — decide what a skill IS (verdict vs prose, what it needs,
 *     how it drives a capture). `applyAgentConfigUpdate` carries them over when
 *     an update omits them and refuses to CHANGE them unless the caller is a
 *     workspace owner or admin.
 *   - Model-reachable tools (chat `create_skill`/`update_skill`, MCP
 *     `dial8_create_skill`/`dial8_update_skill`) no longer accept
 *     `agent_config` at all.
 */
import { z } from 'zod'
import { PRECONDITION_KEYS } from '@/lib/flows/skill-preconditions'

export const AGENT_CONFIG_CONTRACT_KEYS = ['output_contract', 'preconditions', 'capture_mode'] as const
export type AgentConfigContractKey = (typeof AGENT_CONFIG_CONTRACT_KEYS)[number]

const responseStyleSchema = z.union([
  z.object({
    format: z.string().optional(),
    tone: z.string().optional(),
    always_cite_sources: z.boolean().optional(),
  }),
  // Legacy: the chat tool typed this as a free string for a while.
  z.string(),
])

/**
 * Every key a recipe's agent_config may carry. `.strict()`: an unknown key is
 * rejected, never dropped — a writer that sends a key this schema does not
 * know is either stale or probing.
 */
export const agentConfigSchema = z
  .object({
    enabled_tools: z.array(z.string()).optional(),
    disabled_tools: z.array(z.string()).optional(),
    capture_mode: z.enum(['full', 'assist_only']).optional(),
    output_contract: z.enum(['verdict', 'prose']).optional(),
    preconditions: z.array(z.enum(PRECONDITION_KEYS)).optional(),
    response_style: responseStyleSchema.optional(),
    context_rules: z.array(z.string()).optional(),
    /**
     * F1 (src/lib/flows/skill-tool-profile.ts): set by create_skill /
     * update_skill on a skill the agent wrote. With no enabled_tools its
     * act-mode ceiling is reads and drafts only. Carried over when an update
     * omits it, like the contract keys, so a Library save never widens it.
     */
    authored_by: z.literal('agent').optional(),
    /**
     * A skill the live copilot lists as a call playbook
     * (src/lib/live-agent/call-playbooks.ts). Any member may set it (a product
     * decision, 2026-10-20); the copilot fences the body as teammate-written
     * text and caps its size. An update that omits it carries it over.
     */
    live_playbook: z.boolean().optional(),
  })
  .strict()

export type AgentConfigInput = z.infer<typeof agentConfigSchema>

export type ParseAgentConfigResult =
  | { ok: true; config: AgentConfigInput | null }
  | { ok: false; error: string; code: 'AGENT_CONFIG_INVALID' }

/**
 * Validate a raw `agent_config` from a request body. `null` is a valid value
 * (clears the config → core-only tools). Returns the parsed config with every
 * known key preserved.
 */
export function parseAgentConfig(raw: unknown): ParseAgentConfigResult {
  if (raw === null) return { ok: true, config: null }
  if (raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'agent_config must be an object or null', code: 'AGENT_CONFIG_INVALID' }
  }
  const parsed = agentConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path?.length ? ` at ${issue.path.join('.')}` : ''
    return { ok: false, error: `agent_config is invalid${at}: ${issue?.message ?? 'unknown'}`, code: 'AGENT_CONFIG_INVALID' }
  }
  return { ok: true, config: parsed.data }
}

export type ApplyAgentConfigUpdateResult =
  | { ok: true; config: AgentConfigInput | null }
  | { ok: false; error: string; code: 'AGENT_CONFIG_INVALID' | 'AGENT_CONFIG_CONTRACT_LOCKED' }

/** True when the role may change a skill's contract keys. */
export function canChangeAgentContract(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

function contractValue(cfg: Record<string, unknown> | null | undefined, key: AgentConfigContractKey): unknown {
  return cfg ? cfg[key] : undefined
}

function sameContractValue(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** True for a stored agent_config that marks its skill a live call playbook. Pure. */
export function isLivePlaybookConfig(config: unknown): boolean {
  return typeof config === 'object' && config !== null && (config as { live_playbook?: unknown }).live_playbook === true
}

export const AGENT_CONFIG_CONTRACT_LOCKED_ERROR =
  'Only workspace owners and admins can change output_contract, preconditions or capture_mode'

/**
 * Compute the config an update writes. The incoming value REPLACES the stored
 * config (the editor sends the whole thing) except that a contract key the
 * incoming value omits is carried over from the stored config — so an editor
 * or client that does not know the contract keys cannot drop them — and a
 * contract key whose value would change is refused unless `role` may change
 * it. Passing `null` clears the config; that clears the contract keys too and
 * is itself a contract change for a row that had any.
 */
export function applyAgentConfigUpdate(args: {
  existing: unknown
  incoming: unknown
  role: string | null | undefined
}): ApplyAgentConfigUpdateResult {
  const parsed = parseAgentConfig(args.incoming)
  if (!parsed.ok) return parsed
  const existing =
    args.existing && typeof args.existing === 'object' && !Array.isArray(args.existing)
      ? (args.existing as Record<string, unknown>)
      : null

  if (parsed.config === null) {
    const hadContract = AGENT_CONFIG_CONTRACT_KEYS.some((k) => contractValue(existing, k) !== undefined)
    if (hadContract && !canChangeAgentContract(args.role)) {
      return { ok: false, error: AGENT_CONFIG_CONTRACT_LOCKED_ERROR, code: 'AGENT_CONFIG_CONTRACT_LOCKED' }
    }
    return { ok: true, config: null }
  }

  const next: Record<string, unknown> = { ...parsed.config }
  // The agent-authored marker narrows the default ceiling: an editor that
  // doesn't know it must not drop it.
  if (next.authored_by === undefined && existing?.authored_by === 'agent') next.authored_by = 'agent'
  // The live-playbook flag: an editor that doesn't know it must not drop it.
  if (next.live_playbook === undefined && typeof existing?.live_playbook === 'boolean') {
    next.live_playbook = existing.live_playbook
  }
  for (const key of AGENT_CONFIG_CONTRACT_KEYS) {
    const stored = contractValue(existing, key)
    if (next[key] === undefined) {
      // Omitted → carried over, never stripped.
      if (stored !== undefined) next[key] = stored
      continue
    }
    if (!sameContractValue(next[key], stored) && !canChangeAgentContract(args.role)) {
      return { ok: false, error: AGENT_CONFIG_CONTRACT_LOCKED_ERROR, code: 'AGENT_CONFIG_CONTRACT_LOCKED' }
    }
  }
  return { ok: true, config: next as AgentConfigInput }
}
