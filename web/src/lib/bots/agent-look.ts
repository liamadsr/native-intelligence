/**
 * The agent's look (Liam, 2026-10-23: "when you click on the bot you can edit
 * how it looks"): what the person picks for their agent's bot from
 * `bot-avatars`' own options (https://libraries.dev/bots): one of its eighteen
 * shapes and its colour, its material (the package's shading: plush fabric
 * by default, Liam's pick), its face, glasses, a hat, headphones, a bow tie
 * and their colour. The
 * editor is components/bots/agent-look-editor.tsx, the bot that wears it
 * components/bots/agent-bot.tsx (the side panel's computer card and the voice
 * bird).
 *
 * Kept on the account, like the agent's name (lib/voice/assistant-name.ts),
 * with a copy on each device: agent-look-store.ts. Whatever is read back is
 * checked against these lists (parseAgentLook), on the server and on the
 * device, so a stored look is only ever names from them and #RRGGBB colours.
 *
 * Pure, and the package's TYPES only: the lists are spelled out here (their
 * test pins them to the package's), so reading a look never pulls the canvas
 * renderer in.
 */
import type { BotAvatarFace, BotAvatarGlasses, BotAvatarHat, BotAvatarShading, BotAvatarType } from 'bot-avatars'

/** Where the account keeps the look: its key in `user_metadata` and in the profile GET/PATCH (api/account/profile). */
export const AGENT_LOOK_PROFILE_FIELD = 'agent_look'

/** The materials offered: every shading the package draws, plush fabric first (its default, and the agent's). */
export const AGENT_LOOK_SHADINGS = ['fabric', 'plastic', 'smooth', 'crisp', 'flat'] as const satisfies readonly BotAvatarShading[]
export type AgentLookShading = (typeof AGENT_LOOK_SHADINGS)[number]

export interface AgentLook {
  type: BotAvatarType
  /** The body's colour; the shape's own (the package's palette) when absent. */
  color?: string
  /** Its material; fabric when absent (a look saved before there was a choice). */
  shading?: AgentLookShading
  /** The shape's own (eyes) when absent. */
  face?: BotAvatarFace
  glasses: BotAvatarGlasses
  hat: BotAvatarHat
  headphones: boolean
  bowTie: boolean
  /** The hat's, the headphones' and the bow tie's colour; the package's soft black when absent. */
  accessoryColor?: string
}

/**
 * The look until the person picks one: the one Liam made for his own agent
 * (10-23, "make the one I have set up right now the default"): a peach
 * flower in fabric, smiling, in shades. Its accessories' colour (teal) waits
 * for a hat, headphones or a bow tie.
 */
export const DEFAULT_AGENT_LOOK: AgentLook = Object.freeze({
  type: 'flower',
  color: '#EAA06F',
  shading: 'fabric',
  face: 'mouth',
  glasses: 'shades',
  hat: 'none',
  headphones: false,
  bowTie: false,
  accessoryColor: '#58C0A8',
}) as AgentLook

/** Every shape, in the package's order (`botAvatarTypes`). */
export const AGENT_LOOK_TYPES = [
  'clover', 'flower', 'triangle', 'square', 'blob', 'ghost', 'circle', 'drop', 'star',
  'droid', 'mech', 'alien', 'hexagon', 'cat', 'cloud', 'pill', 'pebble', 'puddle',
] as const satisfies readonly BotAvatarType[]
export const AGENT_LOOK_FACES = ['eyes', 'mouth'] as const satisfies readonly BotAvatarFace[]
export const AGENT_LOOK_GLASSES = ['none', 'round', 'square', 'shades'] as const satisfies readonly BotAvatarGlasses[]
export const AGENT_LOOK_HATS = ['none', 'beret', 'beanie', 'party', 'crown'] as const satisfies readonly BotAvatarHat[]

/** The body colours offered: an orange, then the package's palette, one of each hue (the default's peach among them). */
export const AGENT_LOOK_BODY_COLORS = [
  '#E0643C', '#EB7575', '#EAA06F', '#EFDB8E', '#9CD66A', '#2FCB7A', '#1ED3C6',
  '#41C4FF', '#9A62FF', '#DC48FF', '#EE8BDB', '#95A6C4', '#F4F2FA',
] as const
/** The accessories' colours offered (besides the package's soft black). */
export const AGENT_LOOK_ACCESSORY_COLORS = ['#58C0A8', '#41C4FF', '#9A62FF', '#EB7575', '#EFDB8E', '#F4F2FA'] as const

/** What each offered colour is called (a swatch's name for assistive tech). */
export const AGENT_LOOK_COLOR_NAMES: Record<string, string> = {
  '#E0643C': 'Orange', '#EB7575': 'Coral', '#EAA06F': 'Peach', '#EFDB8E': 'Gold', '#9CD66A': 'Lime', '#2FCB7A': 'Green',
  '#1ED3C6': 'Turquoise', '#41C4FF': 'Sky blue', '#9A62FF': 'Violet', '#DC48FF': 'Magenta', '#EE8BDB': 'Pink',
  '#95A6C4': 'Slate', '#F4F2FA': 'White', '#58C0A8': 'Teal',
}

/**
 * Where each shape's base is in its 100-unit box (its lowest filled row,
 * measured from `botAvatarShapes` and `botAvatarParts` on a canvas, 10-23):
 * where the bot stands, as a share of its size (AgentBot draws the box on its
 * element's own box).
 */
const BASE_Y: Record<BotAvatarType, number> = {
  clover: 94, flower: 88.3, triangle: 84, square: 93, blob: 89.5, ghost: 87.5, circle: 92, drop: 92, star: 85.5,
  droid: 90, mech: 88, alien: 92, hexagon: 88.3, cat: 92, cloud: 91, pill: 72, pebble: 79.8, puddle: 89.8,
}

/** Where a look's bot stands in its box, as a share of its size (x, y). */
export function agentLookFeet(look: Pick<AgentLook, 'type'>): { x: number; y: number } {
  return { x: 0.5, y: BASE_Y[look.type] / 100 }
}

const HEX = /^#[0-9A-F]{6}$/i
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)
const hex = (value: unknown): string | undefined => (typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : undefined)

/** A stored look, checked field by field against the lists; null when it isn't one (no type). */
export function parseAgentLook(raw: unknown): AgentLook | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!oneOf(AGENT_LOOK_TYPES, r.type)) return null
  const look: AgentLook = {
    type: r.type,
    glasses: oneOf(AGENT_LOOK_GLASSES, r.glasses) ? r.glasses : 'none',
    hat: oneOf(AGENT_LOOK_HATS, r.hat) ? r.hat : 'none',
    headphones: r.headphones === true,
    bowTie: r.bowTie === true,
  }
  const color = hex(r.color)
  if (color) look.color = color
  look.shading = oneOf(AGENT_LOOK_SHADINGS, r.shading) ? r.shading : 'fabric'
  if (oneOf(AGENT_LOOK_FACES, r.face)) look.face = r.face
  const accessoryColor = hex(r.accessoryColor)
  if (accessoryColor) look.accessoryColor = accessoryColor
  return look
}

/** Two looks draw the same (no face is the shape's own: eyes, for every shape). */
export function sameAgentLook(a: AgentLook, b: AgentLook): boolean {
  return (
    a.type === b.type &&
    (a.color ?? '').toUpperCase() === (b.color ?? '').toUpperCase() &&
    (a.shading ?? 'fabric') === (b.shading ?? 'fabric') &&
    (a.face ?? 'eyes') === (b.face ?? 'eyes') &&
    a.glasses === b.glasses &&
    a.hat === b.hat &&
    a.headphones === b.headphones &&
    a.bowTie === b.bowTie &&
    (a.accessoryColor ?? '').toUpperCase() === (b.accessoryColor ?? '').toUpperCase()
  )
}
