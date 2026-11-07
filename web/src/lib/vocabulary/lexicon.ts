/**
 * The ordinary-word lexicon sound-match uses to keep everyday speech safe
 * (./sound-match.ts rules 2 and 3): ~68k common English words with their
 * inflections, US first names and contractions. See ./LEXICON-NOTICE.md for
 * the sources and licenses, and scripts/vocabulary/build-lexicon.mjs to
 * regenerate ./lexicon-words.ts.
 *
 * Loaded lazily (a ~600 KB module, its own chunk on the client) and once per
 * process or tab.
 */

let cached: Promise<ReadonlySet<string>> | null = null
let cachedNames: Promise<ReadonlySet<string>> | null = null

/** The lexicon's first names that are nothing else (./lexicon-names.ts), lazily. */
export function loadNameOnly(): Promise<ReadonlySet<string>> {
  if (!cachedNames) {
    cachedNames = import('./lexicon-names')
      .then((m) => new Set(m.NAME_ONLY_WORDS.split('\n').filter(Boolean)) as ReadonlySet<string>)
      .catch((err) => {
        cachedNames = null
        throw err
      })
  }
  return cachedNames
}

export function loadLexicon(): Promise<ReadonlySet<string>> {
  if (!cached) {
    cached = import('./lexicon-words')
      .then((m) => new Set(m.LEXICON_WORDS.split('\n').filter(Boolean)) as ReadonlySet<string>)
      .catch((err) => {
        cached = null
        throw err
      })
  }
  return cached
}
