/**
 * Deterministic claim id derivation for replay-safe seed writes.
 *
 * WHY: eve checkpoints at STEP granularity (one model call + its tool calls).
 * A step interrupted after a tool's DB writes commit but before the step
 * checkpoints RE-RUNS the whole tool call on resume (see
 * node_modules/eve/docs/concepts/execution-model-and-durability.md). The
 * `claim` table (migration 109) has NO unique constraint usable for dedupe, so
 * a bare `.insert()` re-inserts the same claim under a fresh random UUID on
 * every replay — duplicating the workspace's freshly-seeded knowledge graph.
 *
 * FIX: give each logical claim a DETERMINISTIC `id` derived only from inputs
 * that are byte-identical across replays of the same tool call, then upsert on
 * `id` with `ignoreDuplicates` — so a replay resolves to the SAME row and is a
 * no-op. We deliberately anchor on the eve SESSION id + TURN id + the claim's
 * own stable content (workspace, type, text, source url) rather than on
 * `ctx.callId`: the tool-call id is minted by the model provider during the
 * (re-run) model call, and eve does not guarantee an identical id when the step
 * re-runs, so it is not a safe replay anchor. session+turn+content IS stable —
 * a resumed step replays the same turn with the same claim payload.
 *
 * Scoping to (session, turn) — not workspace-global — matches the app's claim
 * convention: identical text saved deliberately in two DIFFERENT turns/sessions
 * stays two distinct claims. Only a REPLAY of the same turn collapses.
 *
 * The output is a syntactically valid RFC-4122 v5 UUID (correct version/variant
 * nibbles) so it satisfies the `claim.id UUID` column. We hand-roll the v5
 * hashing over `node:crypto` (already the one crypto dep this agent root uses —
 * see skill-runner/lib/auth.ts) rather than adding an npm uuid dependency to the
 * eve compile.
 */
import { createHash } from 'node:crypto'

/**
 * Fixed namespace UUID for onboarding-researcher seed claims. Any constant,
 * valid UUID works as the v5 namespace; this one is arbitrary and stable.
 */
const CLAIM_NAMESPACE = 'b4b0d1e2-8f3a-5c6d-9e7f-0a1b2c3d4e5f'

/** Stable inputs that identify one logical seed claim across a step replay. */
export interface ClaimIdInputs {
  sessionId: string
  turnId: string
  workspaceId: string
  type: string
  text: string
  sourceUrl: string
}

/**
 * Derive a deterministic v5-formatted UUID for a seed claim. Identical inputs
 * always yield the same id; any field differing yields a different id.
 */
export function deriveClaimId(inputs: ClaimIdInputs): string {
  // \x1f (unit separator) can't appear in a UUID/type/text/url the way a plain
  // delimiter could be forged across field boundaries — keeps the name unambiguous.
  const name = [
    inputs.sessionId,
    inputs.turnId,
    inputs.workspaceId,
    inputs.type,
    inputs.text,
    inputs.sourceUrl,
  ].join('\x1f')

  return uuidv5(name, CLAIM_NAMESPACE)
}

/**
 * RFC-4122 v5 UUID: SHA-1 of (namespace bytes || name), with the version nibble
 * forced to 5 and the variant bits forced to 10. Deterministic and dependency-free.
 */
function uuidv5(name: string, namespace: string): string {
  // Wrap the Buffers in Uint8Array views so crypto's BinaryLike typing is
  // satisfied under this @types/node — same convention as skill-run-token.ts.
  const nsBytes = new Uint8Array(uuidToBytes(namespace))
  const nameBytes = new Uint8Array(Buffer.from(name, 'utf8'))
  const digest = createHash('sha1').update(nsBytes).update(nameBytes).digest()

  const bytes = new Uint8Array(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10

  const hex = Buffer.from(bytes).toString('hex')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}
