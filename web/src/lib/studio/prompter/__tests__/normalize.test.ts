import { describe, expect, it } from 'vitest'
import { contentStems, numberWords, stem, tokenize } from '../normalize'

const words = (text: string) => tokenize(text).map((t) => t.word)
const stems = (text: string) => tokenize(text).map((t) => t.stem)

describe('tokenize', () => {
  it('drops case and punctuation', () => {
    expect(words('Hello, World! (Really?)')).toEqual(['hello', 'world', 'really'])
  })

  it('expands contractions, with or without the apostrophe, curly or straight', () => {
    expect(words("Don't")).toEqual(['do', 'not'])
    expect(words('dont')).toEqual(['do', 'not'])
    expect(words('don’t')).toEqual(['do', 'not'])
    expect(words("We'll see, it's fine, you're right, I'd go, they've won")).toEqual(['we', 'will', 'see', 'it', 'is', 'fine', 'you', 'are', 'right', 'i', 'would', 'go', 'they', 'have', 'won'])
    expect(words("can't won't let's I'm")).toEqual(['can', 'not', 'will', 'not', 'let', 'us', 'i', 'am'])
  })

  it('says numbers the way they are spoken', () => {
    expect(words('5')).toEqual(['five'])
    expect(words('25 deals')).toEqual(['twenty', 'five', 'deals'])
    expect(words('1,200')).toEqual(['one', 'thousand', 'two', 'hundred'])
    expect(words('3.5')).toEqual(['three', 'point', 'five'])
    expect(words('the 1st and 3rd')).toEqual(['the', 'first', 'and', 'third'])
    expect(words('40% off')).toEqual(['forty', 'percent', 'off'])
    expect(words('$20')).toEqual(['twenty', 'dollars'])
    expect(words('R&D')).toEqual(['r', 'and', 'd'])
  })

  it('makes digits and number words the same tokens', () => {
    expect(stems('It takes 15 minutes')).toEqual(stems('it takes fifteen minutes'))
    expect(stems('Step 2')).toEqual(stems('step two'))
  })

  it('folds accents', () => {
    expect(words('Café résumé')).toEqual(['cafe', 'resume'])
  })

  it('treats words a recognizer swaps as the same', () => {
    expect(stems('their')).toEqual(stems('there'))
  })

  it('marks stop words', () => {
    const t = tokenize('the forecast updates on its own')
    expect(t.filter((x) => x.content).map((x) => x.word)).toEqual(['forecast', 'updates'])
  })

  it('keeps where each word came from in the source text', () => {
    const text = "OK, don't drag 25 deals"
    for (const t of tokenize(text)) expect(text.slice(t.from, t.to).length).toBeGreaterThan(0)
    const drag = tokenize(text).find((t) => t.word === 'drag')!
    expect(text.slice(drag.from, drag.to)).toBe('drag')
    const not = tokenize(text).find((t) => t.word === 'not')!
    expect(text.slice(not.from, not.to)).toBe("don't")
  })

  it('reads nothing from empty or symbol-only text', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize(' — … !! ')).toEqual([])
  })
})

describe('stem', () => {
  it('folds the common endings to one form', () => {
    expect(stem('updates')).toBe(stem('update'))
    expect(stem('updated')).toBe(stem('update'))
    expect(stem('updating')).toBe(stem('update'))
    expect(stem('running')).toBe(stem('run'))
    expect(stem('stages')).toBe(stem('stage'))
    expect(stem('companies')).toBe(stem('company'))
    expect(stem('boxes')).toBe(stem('box'))
    expect(stem("team's")).toBe(stem('team'))
  })

  it('leaves short words and -ss words alone', () => {
    expect(stem('is')).toBe('is')
    expect(stem('class')).toBe('class')
    expect(stem('status')).toBe('status')
  })
})

describe('numberWords', () => {
  it('writes whole numbers out', () => {
    expect(numberWords(0)).toBe('zero')
    expect(numberWords(13)).toBe('thirteen')
    expect(numberWords(90)).toBe('ninety')
    expect(numberWords(101)).toBe('one hundred one')
    expect(numberWords(2026)).toBe('two thousand twenty six')
    expect(numberWords(3_000_000)).toBe('three million')
  })
})

describe('contentStems', () => {
  it('is each content word once, stop words out', () => {
    expect(contentStems('Show the forecast, then show the filters')).toEqual(['show', 'forecast', 'filter'])
  })
})
