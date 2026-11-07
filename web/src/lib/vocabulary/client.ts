/**
 * The browser's custom vocabulary: fetches what transcription should know
 * (GET /api/account/vocabulary?view=compiled), keeps it in memory and in
 * localStorage, and builds the sound-match corrector that finished
 * transcript segments, dictation and voice mode go through
 * (docs/plans/custom-vocabulary.md §10).
 *
 * Scoped to one person in one workspace: the cache is keyed on both, and a
 * corrector built for another workspace is never used (a workspace switch
 * without a reload passes text through untouched until the new workspace's
 * vocabulary has loaded), so one workspace's names never reach another's
 * transcripts.
 *
 * Never blocks a recording or a dictation: until the vocabulary (and the
 * lexicon chunk) arrive, text passes through untouched. The assistant's name
 * is always added here, on-device, so Interactive mode's wake word benefits.
 *
 * Safe to import anywhere: nothing touches `window` until a function runs.
 */
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { loadLexicon, loadNameOnly } from './lexicon'
import { vocabularyLogLines, writeVocabularyLog, type CorrectorState, type VocabularyLogContext } from './log'
import { SoundMatchCorrector, type Correction, type NearMiss, type VocabularyEntry } from './sound-match'

const CACHE_PREFIX = 'dial8:vocabulary:v1:'
/** A compile younger than this is not refetched by a plain prime(). */
const FRESH_MS = 60_000

interface Compiled {
  entries: VocabularyEntry[]
  version: string
  workspaceId?: string
  userId?: string
}

let corrector: SoundMatchCorrector | null = null
let builtFor: string | null = null
let builtWorkspace: string | null = null
let fetchedAt = 0
let inflight: Promise<void> | null = null
let pendingForce = false
let builtVersion: string | null = null
/** Why the last load didn't install a corrector (for the log). */
let problem: string | null = 'never loaded'

const cacheKey = (userId: string, workspaceId: string) => `${CACHE_PREFIX}${userId}:${workspaceId}`

function readCache(key: string): Compiled | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Compiled
    return Array.isArray(parsed?.entries) && typeof parsed.version === 'string' ? parsed : null
  } catch {
    return null
  }
}

function writeCache(key: string, c: Compiled) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ entries: c.entries, version: c.version }))
  } catch {
    // Storage full or blocked: the in-memory corrector still works.
  }
}

/** The signed-in person, from the local Supabase session (works offline). */
async function currentUserId(): Promise<string | null> {
  try {
    const { createClient } = await import('@/lib/supabase/client')
    const { data } = await createClient().auth.getSession()
    return data.session?.user?.id ?? null
  } catch {
    return null
  }
}

async function build(c: Compiled, workspaceId: string | null) {
  let assistant = ''
  try {
    // Lazily: the transcript parser (and so this module) is imported by server
    // code too, which must not pull in the browser-only name store.
    const { getAssistantName } = await import('@/lib/voice/assistant-name-store')
    assistant = getAssistantName()
  } catch {
    assistant = ''
  }
  const key = `${workspaceId ?? ''}|${c.version}|${assistant}`
  if (corrector && builtFor === key) return
  const [lexicon, nameOnly] = await Promise.all([loadLexicon(), loadNameOnly().catch(() => new Set<string>())])
  const entries = assistant && !c.entries.some((e) => e.term.toLowerCase() === assistant.toLowerCase())
    ? [...c.entries, { term: assistant }]
    : c.entries
  corrector = new SoundMatchCorrector(entries, lexicon, { nameOnly })
  builtFor = key
  builtWorkspace = workspaceId
  builtVersion = c.version
  problem = null
}

/** The corrector, only when it was built for the workspace the app is in now. */
function activeCorrector(): SoundMatchCorrector | null {
  if (!corrector) return null
  const ws = getClientWorkspaceId()
  if (ws && builtWorkspace && ws !== builtWorkspace) {
    // Switched workspace: drop the old one's words now, then load the new ones.
    corrector = null
    builtFor = null
    builtWorkspace = null
    problem = 'switched workspace; loading the new one'
    void primeVocabulary()
    return null
  }
  return corrector
}

/** What the corrector is right now, for the log. */
export function vocabularyState(): CorrectorState {
  const c = activeCorrector()
  return {
    ready: !!c,
    terms: c?.size ?? 0,
    version: c ? builtVersion : null,
    workspaceId: c ? builtWorkspace : getClientWorkspaceId(),
    problem: c ? null : problem ?? (inflight ? 'still loading' : 'not loaded yet'),
  }
}

/**
 * Make sure the corrector is loaded and current. Cheap to call often (at every
 * recording and dictation start): a fresh compile for the same workspace is
 * not refetched, and calls share one fetch. `force` refetches (after a change
 * in Settings → Vocabulary); one that arrives mid-fetch runs right after it.
 */
export function primeVocabulary(opts: { force?: boolean } = {}): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (inflight) {
    if (opts.force) pendingForce = true
    return inflight
  }
  const ws = getClientWorkspaceId()
  const sameWorkspace = !ws || !builtWorkspace || ws === builtWorkspace
  if (!opts.force && corrector && sameWorkspace && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve()
  inflight = (async () => {
    try {
      if (corrector && !sameWorkspace) {
        // Switched workspace: never correct with the old one's words.
        corrector = null
        builtFor = null
        builtWorkspace = null
      }
      const userId = await currentUserId()
      if (!corrector && userId && ws) {
        const cached = readCache(cacheKey(userId, ws))
        if (cached) await build(cached, ws).catch(() => {})
      }
      const res = await fetch('/api/account/vocabulary?view=compiled', { credentials: 'same-origin' })
      if (!res.ok) {
        if (!corrector) problem = `the server answered ${res.status}`
        return
      }
      const compiled = (await res.json()) as Compiled
      if (!Array.isArray(compiled?.entries)) {
        if (!corrector) problem = 'the server sent no word list'
        return
      }
      const servedWs = compiled.workspaceId ?? ws
      // The app moved on while this was in flight: don't install it.
      const nowWs = getClientWorkspaceId()
      if (nowWs && servedWs && nowWs !== servedWs) {
        if (!corrector) problem = 'switched workspace while loading'
        return
      }
      fetchedAt = Date.now()
      if (compiled.userId && servedWs) writeCache(cacheKey(compiled.userId, servedWs), compiled)
      await build(compiled, servedWs ?? null)
    } catch (err) {
      // Offline or signed out: keep whatever corrector we have.
      if (!corrector) problem = `loading failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160)
    } finally {
      inflight = null
      if (pendingForce) {
        pendingForce = false
        void primeVocabulary({ force: true })
      }
    }
  })()
  return inflight
}

/** After a change in Settings → Vocabulary or by the agent: refetch now. */
export function invalidateVocabulary(): Promise<void> {
  fetchedAt = 0
  return primeVocabulary({ force: true })
}

export function getTranscriptCorrector(): SoundMatchCorrector | null {
  return activeCorrector()
}

/**
 * Correct a plain-text utterance (dictation, voice mode). Untouched until the
 * corrector is ready. With `log`, what was heard, written, fixed and nearly
 * fixed goes into the debug log (./log.ts).
 */
export function correctTranscriptText(text: string, log?: VocabularyLogContext): string {
  if (!text) return text
  const c = activeCorrector()
  let out = text
  let corrections: Correction[] = []
  const nearMisses: NearMiss[] = []
  if (c) {
    try {
      const r = c.correctText(text, log ? nearMisses : undefined)
      out = r.text
      corrections = r.corrections
    } catch {
      out = text
    }
  }
  if (log) writeVocabularyLog(log, vocabularyLogLines({ state: vocabularyState(), heard: text, wrote: out, corrections, nearMisses }))
  return out
}

interface SegmentLike {
  text: string
  isFinal: boolean
  words: Array<{ word: string; start: number; end: number; confidence: number; speaker?: number }>
}

/**
 * Correct a finished transcript segment. The text is rewritten; the word list
 * follows when it lines up with the text one token per word (Deepgram's
 * smart-format usually keeps it so), merging a multi-word span into one word
 * that keeps the first word's start and speaker tag and the last one's end.
 */
export function correctFinalSegment<T extends SegmentLike>(segment: T, log?: VocabularyLogContext): T {
  const c = activeCorrector()
  if (!c || !segment.isFinal || !segment.text) return segment
  try {
    const tokens = segment.text.trim().split(/\s+/).filter(Boolean)
    const nearMisses: NearMiss[] = []
    const r = c.correctTokens(tokens, log ? nearMisses : undefined)
    // Meetings log only what came close: a long call would otherwise fill the log.
    if (log && (r.corrections.length || nearMisses.length)) {
      writeVocabularyLog(log, vocabularyLogLines({ state: vocabularyState(), heard: segment.text, wrote: r.tokens.join(' '), corrections: r.corrections, nearMisses }))
    }
    if (!r.corrections.length) return segment
    const text = r.tokens.join(' ')
    const words = segment.words.length === tokens.length ? mergeWords(segment.words, r.corrections) : segment.words
    return { ...segment, text, words }
  } catch {
    return segment
  }
}

function mergeWords<W extends SegmentLike['words'][number]>(words: readonly W[], corrections: readonly Correction[]): W[] {
  const byIndex = new Map(corrections.map((c) => [c.index, c]))
  const out: W[] = []
  for (let i = 0; i < words.length; ) {
    const c = byIndex.get(i)
    if (!c) {
      out.push(words[i])
      i++
      continue
    }
    const span = words.slice(i, i + c.length)
    out.push({
      ...span[0],
      word: c.to.toLowerCase(),
      end: span[span.length - 1].end,
      confidence: Math.min(...span.map((w) => w.confidence)),
    })
    i += c.length
  }
  return out
}

/** Tests only. */
export function __resetVocabularyForTests(next?: SoundMatchCorrector | null, workspaceId: string | null = null) {
  corrector = next ?? null
  builtFor = null
  builtWorkspace = workspaceId
  fetchedAt = 0
  inflight = null
  pendingForce = false
  builtVersion = null
  problem = next ? null : 'never loaded'
}
