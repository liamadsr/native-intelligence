/**
 * The face ids an AI teammate can hold (`ai_team_member.bot_character`,
 * migration 294), as plain data: the ids, what each is called, and how a face
 * built from parts is spelled. No art: the app draws no faces any more (every
 * agent wears the one agent icon, AgentIcon), but the column, its insert trigger and the voice
 * dealer (bot-voice.ts) still key on these ids, and a new agent is still named
 * after its face when it's given no name.
 *
 * The lists below are append-only: a part's place in its list is what its
 * letter means in a built face's id (bot-faces.test.ts pins them).
 */

/** Each character's id and its name, in the catalogue's order. */
const CHARACTER_NAMES = {
  mail: 'Email',
  live: 'Live',
  research: 'Research',
  writer: 'Writer',
  dev: 'Developer',
  triage: 'Triage',
  extraction: 'Extraction',
  reconciler: 'Reconciler',
  chat: 'Assistant',
  scout: 'Scout',
  calendar: 'Scheduler',
  coach: 'Coach',
  deals: 'Deals',
  browser: 'Browser',
  flows: 'Flows',
  knowledge: 'Knowledge',
  notes: 'Note taker',
  sprout: 'Sprout',
  ember: 'Ember',
  dew: 'Dew',
  shroom: 'Shroom',
  berry: 'Berry',
  nova: 'Nova',
  acorn: 'Acorn',
} as const

export type BotLookId = keyof typeof CHARACTER_NAMES

/** A plain shape's name: a built face's body can be one. */
const SHAPE_NAMES: Readonly<Record<string, string>> = {
  round: 'Round',
  egg: 'Egg',
  drop: 'Drop',
  triangle: 'Triangle',
  square: 'Square',
  pill: 'Pill',
  flower: 'Flower',
  heart: 'Heart',
  cloud: 'Cloud',
  star: 'Star',
  hexagon: 'Hexagon',
  bean: 'Bean',
}

/** A built face's id: "x", then body (two letters), colour, eyes, glasses, what's worn and its colour (one each). */
export type BuiltBotId = `x${string}`

/** Anything a teammate can hold as its face: a character's id or a built one's. */
export type BotCharacterType = BotLookId | BuiltBotId

export interface BotCharacterInfo<T extends BotCharacterType = BotCharacterType> {
  /** Its id: what `ai_team_member.bot_character` holds. */
  type: T
  /** What to call it. */
  name: string
}

/**
 * Every character, in the order a free face is handed out in (the column's
 * CHECK and `free_bot_character` agree). Each once.
 */
const ORDER: readonly BotLookId[] = [
  'chat',
  'research',
  'reconciler',
  'sprout',
  'writer',
  'triage',
  'extraction',
  'berry',
  'dev',
  'nova',
  'live',
  'flows',
  'notes',
  'ember',
  'scout',
  'dew',
  'coach',
  'mail',
  'knowledge',
  'calendar',
  'acorn',
  'browser',
  'shroom',
  'deals',
]

export const BOT_CHARACTERS: readonly BotCharacterInfo<BotLookId>[] = ORDER.map((type) => ({ type, name: CHARACTER_NAMES[type] }))

// ── A built face's id ───────────────────────────────────────────────────────

/** A face built from parts: what its id spells. */
export interface BotRecipe {
  /** A character's id, or a plain shape's. */
  body: string
  color?: string
  eyes?: string
  glasses?: string
  worn?: string
  wornColor?: string
}

/**
 * The parts, in the order their letters count them. APPEND ONLY: an id made
 * yesterday must mean the same face tomorrow.
 */
export const BUILT_BODIES: readonly string[] = [
  'round', 'egg', 'drop', 'triangle', 'square', 'pill', 'flower', 'heart', 'cloud', 'star', 'hexagon', 'bean',
  'chat', 'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
  'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'scout', 'dew',
  'coach', 'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom', 'deals',
]
export const BUILT_COLORS: readonly string[] = [
  '#F47FB4', '#D573DC', '#9B6BFF', '#5B7BFF', '#4FB4FF', '#57C7A8',
  '#BFDB4A', '#F7CE4B', '#F28B6C', '#2E3350', '#8B5A3C', '#F4F2FA',
]
export const BUILT_EYES: readonly string[] = ['classic', 'dot', 'googly', 'sparkle', 'ring', 'sleepy', 'happy']
export const BUILT_GLASSES: readonly string[] = ['round', 'square', 'shades', 'hearts', 'monocle']
export const BUILT_WEAR: readonly string[] = [
  'headset', 'bowtie', 'cap', 'beanie', 'beret', 'tophat', 'party', 'crown', 'halo', 'flower', 'leaf', 'antenna',
]

const BUILT = /^x[a-z]{7}$/

const letter = (n: number) => String.fromCharCode(97 + n)
const number = (c: string) => c.charCodeAt(0) - 97
/** "a" is none (or the part's own colour); "b" the first in the list. */
const pick = <T,>(list: readonly T[], c: string): T | undefined | null => {
  const n = number(c)
  return n === 0 ? undefined : n <= list.length ? list[n - 1] : null
}
const place = <T,>(list: readonly T[], value: T | undefined): string | null => {
  if (value === undefined) return 'a'
  const i = list.indexOf(value)
  return i < 0 || i >= 25 ? null : letter(i + 1)
}

/** The id a recipe is stored as, or null for one that can't be (a part or a colour not in the lists). */
export function builtBotId(recipe: BotRecipe): BuiltBotId | null {
  const body = BUILT_BODIES.indexOf(recipe.body)
  if (body < 0) return null
  const parts = [
    place(BUILT_COLORS, recipe.color?.toUpperCase()),
    place(BUILT_EYES, !recipe.eyes || recipe.eyes === 'classic' ? undefined : recipe.eyes),
    place(BUILT_GLASSES, recipe.glasses),
    place(BUILT_WEAR, recipe.worn),
    place(BUILT_COLORS, recipe.worn ? recipe.wornColor?.toUpperCase() : undefined),
  ]
  if (parts.some((p) => p === null)) return null
  return `x${letter(Math.floor(body / 26))}${letter(body % 26)}${parts.join('')}` as BuiltBotId
}

/** The recipe an id stands for, or null when it isn't a built face's. */
export function builtBotRecipe(id: unknown): BotRecipe | null {
  if (typeof id !== 'string' || !BUILT.test(id)) return null
  const body = BUILT_BODIES[number(id[1]) * 26 + number(id[2])]
  const color = pick(BUILT_COLORS, id[3])
  const eyes = pick(BUILT_EYES, id[4])
  const glasses = pick(BUILT_GLASSES, id[5])
  const worn = pick(BUILT_WEAR, id[6])
  const wornColor = pick(BUILT_COLORS, id[7])
  if (!body || color === null || eyes === null || glasses === null || worn === null || wornColor === null) return null
  // A colour for something that isn't worn means nothing: only the id without it is that face's.
  if (!worn && wornColor) return null
  // "b" for the eyes would be the classic ones, which is "a".
  if (eyes === 'classic') return null
  const recipe: BotRecipe = { body }
  if (color) recipe.color = color
  if (eyes) recipe.eyes = eyes
  if (glasses) recipe.glasses = glasses
  if (worn) recipe.worn = worn
  if (wornColor) recipe.wornColor = wornColor
  return recipe
}

/** Whether `id` is a built face's: an id a recipe is stored as. */
export function isBuiltBotId(id: unknown): id is BuiltBotId {
  return builtBotRecipe(id) !== null
}

/** What to call a body: a character's name, or a plain shape's; Sprout's for anything else. */
function bodyName(id: string): string {
  if (Object.hasOwn(SHAPE_NAMES, id)) return SHAPE_NAMES[id]
  if (Object.hasOwn(CHARACTER_NAMES, id)) return CHARACTER_NAMES[id as BotLookId]
  return CHARACTER_NAMES.sprout
}

/** What to call a face: the character's name, or a built face's body's. */
export function characterName(type: BotCharacterType): string {
  const recipe = builtBotRecipe(type)
  return bodyName(recipe ? recipe.body : type)
}
