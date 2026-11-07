/**
 * Voice-profile shared contract — types + tuning constants imported across the
 * "Teach Dial8 your voice" feature (enrollment flow, API routes, dashboard
 * nudge, live self-verification).
 *
 * Wave-0 contract: pure types and numeric constants, zero runtime dependencies.
 * Everything downstream imports from here so the thresholds live in one place.
 */

/** WavLM chunk embedding dimensionality — asserted before any cosine compare. */
export const EMBEDDING_DIM = 512

/** A single unit-norm voice prototype (per-passage mean embedding). */
export type VoiceProfilePrototype = number[]

/** Shape returned by GET /api/account/voice-profile. */
export interface VoiceProfileStatus {
  /** True once the user has a stored voice profile. */
  enrolled: boolean
  /** Mean per-chunk quality of the stored profile (0..1), or null if none. */
  quality: number | null
  /** Number of stored embedding chunks. */
  chunkCount: number
  /** ISO timestamp the profile was created, or null if not enrolled. */
  createdAt: string | null
}

/** How a stored voice-profile row was produced. */
export type VoiceProfileSource = 'settings_training' | 'session_confirm'

/** One embedded chunk posted from the enrollment flow. */
export interface VoiceProfileChunk {
  /** WavLM embedding — length EMBEDDING_DIM, finite numbers. */
  embedding: number[]
  /** Per-chunk quality score 0..1 (duration + level + SNR proxy). */
  quality: number
  /** Passage session id — one per story passage. */
  sessionId: string
}

/** Body for POST /api/account/voice-profile (re-enrollment). */
export interface PostVoiceProfileBody {
  chunks: VoiceProfileChunk[]
  source: VoiceProfileSource
}

/** Body for POST /api/account/captures/[id]/self-binding. */
export interface PostSelfBindingBody {
  speaker_label: string
  /** Qualifying segment embeddings from the vote window (2–5, each EMBEDDING_DIM). */
  embeddings: number[][]
}

/** Body for POST /api/account/captures/[id]/self-confirm. */
export interface PostSelfConfirmBody {
  speaker_label: string
  /** "mine": this voice is me. "not_mine": it is not (undoes a binding to it). */
  decision: 'mine' | 'not_mine'
  /** The voice's segment embeddings, for "mine" (0–MAX_SELF_TOPUP_EMBEDDINGS). */
  embeddings?: number[][]
}

/** Response for POST /api/account/captures/[id]/self-confirm. */
export interface PostSelfConfirmResult {
  /** "mine": the self row now carries the label as confirmed. */
  bound?: boolean
  /** "not_mine": a binding to this label was removed. */
  unbound?: boolean
  /** Embeddings added to the user's voice profile. */
  learned?: number
  reason?: string
}

/** Response for POST /api/account/captures/[id]/self-binding. */
export interface PostSelfBindingResult {
  granted: boolean
  /** Present when granted:false — why the grant did not happen. */
  reason?: string
}

// --- Live self-verification tuning (voting window) ---

/** A vote qualifies only when selfSim clears this cosine threshold. */
export const SELF_VERIFY_THRESHOLD = 0.8
/** selfSim must beat the best contact candidate by at least this margin. */
export const SELF_VERIFY_MARGIN = 0.03
/** Sustained selfSim below this on local_1 drives display demotion. */
export const SELF_MISMATCH_THRESHOLD = 0.6
/** Server-side self-binding grant needs at least this many matching embeddings. */
export const SELF_BINDING_MIN_SERVER_MATCHES = 2

// --- "Is this you?" and "This is me" (followups issue 11) ---
//
// Attendees are matched by a gallery that learns from meetings: a person links
// a voice to a contact, those segments enroll, and the next meeting matches on
// meeting audio. The user's own profile was one clean enrollment that never
// learned, so in a room it rarely cleared SELF_VERIFY_THRESHOLD. These give the
// user the same loop: a suggestion when a voice is close, a confirm, and
// learning from the confirmed voice.

/** A voice this close (and beating every contact) is suggested as the user. */
export const SELF_SUGGEST_THRESHOLD = 0.7
/**
 * A confirmed voice's embeddings teach the user's profile only when most of
 * them are at least this close to it already (the "not a stranger" floor — the
 * same line below which local_1 is demoted from "You"). A first confirm with
 * no profile yet teaches unconditionally, as an attendee's first link does.
 */
export const SELF_TOPUP_FLOOR = SELF_MISMATCH_THRESHOLD
/** Embeddings one confirm may add, sampled across the voice's segments. */
export const MAX_SELF_TOPUP_EMBEDDINGS = 8
/** Meeting-learned rows kept per user (oldest dropped); the Settings passages are never dropped. */
export const MAX_SESSION_CONFIRM_ROWS = 40

// --- Enrollment volume + quality gates ---

/** Minimum accepted chunks across all passages to fully trust a profile. */
export const ENROLLMENT_MIN_CHUNKS = 12
/**
 * Maximum stored chunks for one enrollment — the ceiling the enrollment flow
 * and the POST route BOTH enforce (single source of truth). One-time
 * self-enrollment stores EVERY quality-accepted chunk (no per-passage
 * downsample), so this is a defensive envelope, not a target: a pathological
 * over-long take is evenly subsampled to fit rather than 400'd. 60 chunks ×
 * 512 floats is well under any body limit. (Contrast the CRM contact pipeline,
 * where sampleEmbeddingsForEnrollment caps per-meeting to stop one meeting from
 * dominating a multi-meeting profile — that rationale does not apply to a
 * single-shot self-read of one voice.)
 */
export const MAX_ENROLLMENT_CHUNKS = 60
/** Length of each voiced-audio chunk in seconds. */
export const ENROLLMENT_CHUNK_SECONDS = 3
/** Chunks below this quality score are dropped. */
export const ENROLLMENT_MIN_CHUNK_QUALITY = 0.5

// Per-chunk quality sub-score weights (§4):
//   quality = clamp01(0.5·durationScore + 0.3·levelScore + 0.2·snrScore).
// The chunker computes each sub-score; these weight their aggregate.
/** Weight of the duration sub-score in the aggregate quality. */
export const QUALITY_WEIGHT_DURATION = 0.5
/** Weight of the level sub-score in the aggregate quality. */
export const QUALITY_WEIGHT_LEVEL = 0.3
/** Weight of the SNR-proxy sub-score in the aggregate quality. */
export const QUALITY_WEIGHT_SNR = 0.2
/** Minimum accepted chunks for a single passage to advance. */
export const PASSAGE_MIN_CHUNKS = 4
/** Min pairwise cosine among the 3 passage prototypes (guards against a second voice). */
export const PASSAGE_CONSISTENCY_MIN = 0.7
/** Max re-read attempts per passage before the escape hatch. */
export const PASSAGE_MAX_RETRIES = 3

// --- Quality label thresholds (settings status card) ---

/** Mean chunk quality at/above this labels the profile "Excellent". */
export const QUALITY_LABEL_EXCELLENT = 0.85
/** Mean chunk quality at/above this labels the profile "Good". */
export const QUALITY_LABEL_GOOD = 0.65

/** Human-readable quality band for a mean chunk-quality score. */
export type VoiceQualityLabel = 'excellent' | 'good' | 'fair'

/** Bucket a mean chunk-quality score into a display label. */
export function qualityLabel(mean: number): VoiceQualityLabel {
  if (mean >= QUALITY_LABEL_EXCELLENT) return 'excellent'
  if (mean >= QUALITY_LABEL_GOOD) return 'good'
  return 'fair'
}
