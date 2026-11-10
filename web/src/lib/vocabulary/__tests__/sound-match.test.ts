import { describe, expect, it } from 'vitest'
import { LEXICON_WORDS } from '../lexicon-words'
import { NAME_ONLY_WORDS } from '../lexicon-names'
import { SoundMatchCorrector, isOrdinary, letters, similarity, soundKey, spoken } from '../sound-match'

/**
 * Pins the sound-match rules to what the harness measured
 * (docs/plans/custom-vocabulary.md §9; desktop/.claude/boost-test/v2).
 * The TS port was checked edit-for-edit against the Python harness on 38
 * recordings (637 edits with the review guards, identical); these cases are
 * the ones that matter.
 */
const lexicon = new Set(LEXICON_WORDS.split('\n').filter(Boolean))
const DICT = [
  'Route8', 'Supabase', 'Tauri', 'Nemotron', 'Deepgram', 'MCP', 'PostHog', 'Sortformer', 'SentencePiece',
  'Prabhjot', 'Grokbot', 'RLS', 'Sellar', 'Drizzle', 'Retool', 'iCloud', 'Linear', 'Bun', 'Llama', 'Pinecone',
]
const corrector = new SoundMatchCorrector(DICT.map((term) => ({ term })), lexicon)
const fix = (text: string) => corrector.correctText(text).text

describe('spoken forms and sound keys', () => {
  it('spells out digits, splits camelCase and spells short acronyms', () => {
    expect(spoken('Route8')).toBe('route eight')
    expect(spoken('PostHog')).toBe('post hog')
    expect(spoken('RLS')).toBe('ar el es')
    expect(spoken('WebRTC')).toBe('web ar tee see')
  })

  it('keeps a word-initial vowel marker, so iCloud is not cloud and RLS is not rolls', () => {
    expect(soundKey(spoken('iCloud'))).toBe('Akld')
    expect(soundKey(spoken('cloud'))).toBe('kld')
    expect(soundKey(spoken('RLS'))).toBe('ArAlAs')
    expect(soundKey(spoken('rolls'))).toBe('rls')
    expect(soundKey(spoken('route eight'))).toBe(soundKey(spoken('Route8')))
  })

  it('scores like difflib.SequenceMatcher.ratio', () => {
    expect(similarity('spbs', 'sprbs')).toBeCloseTo(8 / 9, 12)
    expect(similarity('abcd', 'bcde')).toBe(0.75)
    expect(similarity('', '')).toBe(1)
    expect(similarity('abc', 'xyz')).toBe(0)
  })

  it('letters() keeps only lowercase letters and digits', () => {
    expect(letters("Post-Hog's 2")).toBe('posthogs2')
  })
})

describe('isOrdinary', () => {
  it('knows common words, inflections, contractions and first names', () => {
    for (const w of ['cellar', 'rolls', 'cones', 'email', "we'll", 'Liam', "Sarah's", 'running']) expect(isOrdinary(w, lexicon), w).toBe(true)
    for (const w of ['Superbase', 'Nematron', 'Grockbutt', 'Degram']) expect(isOrdinary(w, lexicon), w).toBe(false)
  })
})

describe('SoundMatchCorrector', () => {
  it('fixes what the engine misspells (harness examples)', () => {
    expect(fix('Open the Superbase logs')).toBe('Open the Supabase logs')
    expect(fix('We moved the local model to Nematron')).toBe('We moved the local model to Nemotron')
    expect(fix('Ping Prab Jot about it')).toBe('Ping Prabhjot about it')
    expect(fix('Grockbutt and friends')).toBe('Grokbot and friends')
    expect(fix('kept Degram as the fallback')).toBe('kept Deepgram as the fallback')
  })

  it('respells spans whose letters equal a term', () => {
    expect(fix('the post hog dashboard')).toBe('the PostHog dashboard')
    expect(fix('sort former handles it')).toBe('Sortformer handles it')
    expect(fix('the sentence piece tokenizer')).toBe('the SentencePiece tokenizer')
    expect(fix('the Mcp server')).toBe('the MCP server')
  })

  it('turns spoken digits into the term ("route eight" → Route8)', () => {
    expect(fix('Open the route eight desktop app')).toBe('Open the Route8 desktop app')
  })

  it('keeps punctuation around a replacement', () => {
    expect(fix('Check Superbase, then deploy.')).toBe('Check Supabase, then deploy.')
    expect(fix('(Superbase)')).toBe('(Supabase)')
  })

  it('never turns ordinary speech into a term (the trap sentences)', () => {
    const traps = [
      'Take the wine down to the cellar.',
      'We picked up pine cones along the trail.',
      'Add a drizzle of olive oil at the end.',
      'The factory had to retool for the new car.',
      'My notes sync to the cloud.',
      'We baked bread rolls and a hot dog bun.',
      'Hand me the linear ruler from the desk.',
      'Liam said it was fine.',
      'It was a very long day.',
    ]
    for (const t of traps) expect(fix(t), t).toBe(t)
  })

  it('uses "sounds like" forms, but never ones that are ordinary words', () => {
    const c = new SoundMatchCorrector(
      [{ term: 'Kowalczyk', soundsLike: ['Kovalchik'] }, { term: 'Nguyen', soundsLike: ['when', 'Guyan'] }],
      lexicon,
    )
    expect(c.correctText('Kovalchik will review it').text).toBe('Kowalczyk will review it')
    expect(c.correctText('Guyan joined late').text).toBe('Nguyen joined late')
    expect(c.correctText('when did you join').text).toBe('when did you join')
  })

  it('reports what it changed, and returns the text untouched when nothing matches', () => {
    const r = corrector.correctText('  Open the Superbase logs ')
    expect(r.text).toBe('  Open the Supabase logs ')
    expect(r.corrections).toEqual([{ kind: 'sound', from: 'Superbase', to: 'Supabase', output: 'Supabase', index: 2, length: 1, score: expect.any(Number) }])
    expect(corrector.correctText('nothing to see here')).toEqual({ text: 'nothing to see here', corrections: [] })
    expect(corrector.correctText('')).toEqual({ text: '', corrections: [] })
  })

  it('never joins words across punctuation (a sentence or clause break)', () => {
    const c = new SoundMatchCorrector([{ term: 'Home Page' }, { term: 'PostHog' }], lexicon)
    expect(c.correctText('Then go home. Page me later.').text).toBe('Then go home. Page me later.')
    expect(c.correctText('I wrote the post. Hog farms are next.').text).toBe('I wrote the post. Hog farms are next.')
    expect(c.correctText('Check the post hog dashboard.').text).toBe('Check the PostHog dashboard.')
  })

  it('keeps a possessive or contraction ending', () => {
    expect(fix("Nematron's numbers look good")).toBe("Nemotron's numbers look good")
    expect(fix("the Superbase's logs")).toBe("the Supabase's logs")
  })

  it('keeps line breaks and spacing outside a replacement', () => {
    expect(fix('First line Superbase\nSecond  line\n\nThird')).toBe('First line Supabase\nSecond  line\n\nThird')
  })

  it('leaves names made of ordinary words alone: no recasing, no reaching them by sound', () => {
    const c = new SoundMatchCorrector([{ term: 'Mobile App' }, { term: 'Next Steps' }], lexicon)
    expect(c.correctText('the mobile app is slow').text).toBe('the mobile app is slow')
    expect(c.correctText('our mobile apps are slow').text).toBe('our mobile apps are slow')
    expect(c.correctText('the next step is clear').text).toBe('the next step is clear')
  })
})

describe('"sounds like" phrases of ordinary words', () => {
  const c = new SoundMatchCorrector([{ term: 'Supabase', soundsLike: ['super base'] }, { term: 'Nguyen', soundsLike: ['when'] }], lexicon)

  it('a typed phrase is honored when heard exactly', () => {
    expect(c.correctText('check the super base logs').text).toBe('check the Supabase logs')
    expect(c.correctText('Super Base, then deploy').text).toBe('Supabase, then deploy')
  })

  it('never by approximate sound, and a single ordinary word is still ignored', () => {
    expect(c.correctText('the super bass was loud').text).toBe('the super bass was loud')
    expect(c.correctText('call me when ready').text).toBe('call me when ready')
  })
})

describe('terms with numbers or spelled letters, word for word', () => {
  const c = new SoundMatchCorrector(['A16Z', 'APIM', 'Route8', 'AI', 'RLS', 'Web3'].map((term) => ({ term })), lexicon)

  it('numbers are said as numbers', () => {
    expect(spoken('A16Z')).toBe('a sixteen z')
    expect(spoken('Q40')).toBe('q forty')
    expect(spoken('2026')).toBe('two zero two six')
  })

  it('a term said or spelled the way it is written', () => {
    expect(c.correctText('talk to the A sixteen Z cofounder').text).toBe('talk to the A16Z cofounder')
    expect(c.correctText("that's the a sixteen z stuff.").text).toBe("that's the A16Z stuff.")
    expect(c.correctText('the A 16 Z team').text).toBe('the A16Z team')
    expect(c.correctText('the a one six z team').text).toBe('the A16Z team')
    expect(c.correctText('ask the A P I M team').text).toBe('ask the APIM team')
    expect(c.correctText('check R L S again').text).toBe('check RLS again')
    expect(c.correctText('we use route 8').text).toBe('we use Route8')
    expect(c.correctText('Web three apps').text).toBe('Web3 apps')
  })

  it('heard close to the word: by sound, as before', () => {
    expect(c.correctText('the APAM team').text).toBe('the APIM team')
  })

  it('never from everyday words that only look like letters', () => {
    expect(c.correctText('it was a I mean fine').text).toBe('it was a I mean fine')
    expect(c.correctText('a sixteen year old').text).toBe('a sixteen year old')
    expect(c.correctText('A, sixteen. Z').text).toBe('A, sixteen. Z')
  })

  it('traces what it left alone and why', () => {
    const trace: import('../sound-match').NearMiss[] = []
    c.correctText('the api am team', trace)
    expect(trace[0]).toMatchObject({ from: 'api am', to: 'APIM', reason: 'ordinary words' })
  })
})

describe('a dead heat between two words', () => {
  it('goes to the one earlier in the list (the person\'s own), not the later letter', () => {
    // A name fixed to another spelling ("Jay Ng" → Giang, learned from an edit):
    // the name is the word's "sounds like", so the two always tie.
    const sentence = 'let you know that Jiang is not coming to work tomorrow'
    const yours = new SoundMatchCorrector([{ term: 'Giang', soundsLike: ['Jay Ng'] }, { term: 'Jay Ng' }], lexicon)
    expect(yours.correctText(sentence).text).toBe('let you know that Giang is not coming to work tomorrow')
    const names = new SoundMatchCorrector([{ term: 'Jay Ng' }, { term: 'Giang', soundsLike: ['Jay Ng'] }], lexicon)
    expect(names.correctText(sentence).text).toBe('let you know that Jay Ng is not coming to work tomorrow')
  })
})

describe('a one-word "sounds like" that is a name', () => {
  const nameOnly = new Set(NAME_ONLY_WORDS.split('\n').filter(Boolean))

  it('is matched when heard exactly (learned: Toma → Thomas), though the name is an ordinary word', () => {
    const c = new SoundMatchCorrector([{ term: 'Thomas', soundsLike: ['Toma'] }], lexicon, { nameOnly })
    expect(c.correctText("Let me reach out to Toma tomorrow and see if he's good").text).toBe(
      "Let me reach out to Thomas tomorrow and see if he's good",
    )
    // Its own possessive kept.
    expect(c.correctText("Toma's laptop").text).toBe("Thomas's laptop")
  })

  it('an everyday word never is: one-word forms that are common words stay out', () => {
    const c = new SoundMatchCorrector([{ term: 'Nguyen', soundsLike: ['when'] }, { term: 'there', soundsLike: ['their'] }], lexicon, { nameOnly })
    expect(c.correctText('when is their meeting').text).toBe('when is their meeting')
  })

  it('the list holds names only, never common words, days or places', () => {
    for (const w of ['toma', 'thomas']) expect(nameOnly.has(w), w).toBe(true)
    for (const w of ['their', 'when', 'jay', 'georgia', 'may', 'friday', 'will']) expect(nameOnly.has(w), w).toBe(false)
  })
})

