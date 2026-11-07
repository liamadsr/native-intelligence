/**
 * Deterministic id derivation for onboarding-seeded rows (the starter project and
 * its starter actions), so `save_starter_content` is idempotent across BOTH a
 * step replay AND a genuine second run for the same workspace.
 *
 * WHY deterministic ids (not a tag lookup): eve re-runs an interrupted step's
 * whole tool call on resume, and the seeding contract also promises a plain
 * "second call for a workspace that already has an onboarding-seeded project is a
 * no-op returning the existing ids". A `workspace`-scoped v5 UUID gives us both
 * for free: the starter project's id is a pure function of the workspace, so the
 * pre-check ("does a project with this id already exist?") is exact, and the
 * write is an upsert-to-the-same-primary-key no-op on replay. This mirrors
 * `claim-id.ts`, which anchors seed claims on stable content for the same reason.
 *
 * SCOPING — deliberately workspace-global, NOT session/turn-scoped like claims:
 * there is exactly ONE onboarding-seeded project per workspace, forever. Anchoring
 * on the workspace id alone (plus a role discriminator for the project) means a
 * fresh research SESSION for the same workspace still resolves to the same row and
 * no-ops, which is the idempotency the contract requires. Actions derive from the
 * project id + their ordinal, so the Nth starter action is stable across replays.
 *
 * The output is a syntactically valid RFC-4122 v5 UUID (correct version/variant
 * nibbles) so it satisfies the `projects.id` / `actions.id` UUID columns. We
 * hand-roll v5 over `node:crypto` — no npm `uuid` dep in the eve compile — exactly
 * like `claim-id.ts`.
 */
import { createHash } from 'node:crypto'

/**
 * Fixed namespace UUID for onboarding-seeded starter rows. Distinct from the seed
 * claim namespace so a project and a claim can never collide on the same id.
 * Any constant, valid UUID works as the v5 namespace; this one is arbitrary and
 * stable.
 */
const SEED_NAMESPACE = 'c5c1e2f3-9a4b-5d7e-8f90-1b2c3d4e5f60'

/** The literal that discriminates the starter-project id within a workspace. */
const PROJECT_KIND = 'onboarding-starter-project'

/** Same, for the Marketing-role starter campaign. */
const CAMPAIGN_KIND = 'onboarding-starter-campaign'

/**
 * Hard cap on seeded starter actions. Lives here (not in save_starter_content)
 * because it bounds the deterministic id space: seeded action ids are exactly
 * deriveStarterActionId(projectId, 0..MAX_STARTER_ACTIONS-1), which is what lets
 * finish_research enumerate them to reconstruct the seeded summary from the DB.
 */
export const MAX_STARTER_ACTIONS = 4

/**
 * The starter project's deterministic id for a workspace. Same workspace → same
 * id, forever — so the pre-existence check is exact and the upsert is a no-op on
 * replay or re-run.
 */
export function deriveStarterProjectId(workspaceId: string): string {
  return uuidv5([workspaceId, PROJECT_KIND].join('\x1f'), SEED_NAMESPACE)
}

/**
 * The starter CAMPAIGN's deterministic id for a workspace — same discipline,
 * different discriminator, so there is exactly one onboarding-seeded campaign
 * per workspace and a replay upserts into it instead of duplicating.
 */
export function deriveStarterCampaignId(workspaceId: string): string {
  return uuidv5([workspaceId, CAMPAIGN_KIND].join('\x1f'), SEED_NAMESPACE)
}

/**
 * A starter action's deterministic id, anchored on the (already-deterministic)
 * project id + the action's ordinal position in the seed set. Position — not
 * title — is the anchor so a replay of the SAME call resolves each slot to the
 * same row even if the model re-emits slightly different prose; the whole set is
 * regenerated identically on replay because it derives from the project id.
 */
export function deriveStarterActionId(projectId: string, index: number): string {
  return uuidv5([projectId, 'action', String(index)].join('\x1f'), SEED_NAMESPACE)
}

/**
 * RFC-4122 v5 UUID: SHA-1 of (namespace bytes || name), version nibble forced to
 * 5 and variant bits to 10. Deterministic and dependency-free.
 */
function uuidv5(name: string, namespace: string): string {
  // Wrap the Buffers in Uint8Array views so crypto's BinaryLike typing is
  // satisfied under this @types/node — same convention as claim-id.ts.
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
