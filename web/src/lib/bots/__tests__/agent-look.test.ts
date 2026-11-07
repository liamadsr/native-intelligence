/**
 * The agent's look (agent-look.ts): its lists are the package's own, a stored
 * look is checked field by field, each shape stands on its base.
 */
import { describe, expect, it } from 'vitest'
import { botAvatarFaces, botAvatarTypes } from 'bot-avatars'
import {
  AGENT_LOOK_ACCESSORY_COLORS,
  AGENT_LOOK_BODY_COLORS,
  AGENT_LOOK_COLOR_NAMES,
  AGENT_LOOK_FACES,
  AGENT_LOOK_SHADINGS,
  AGENT_LOOK_TYPES,
  DEFAULT_AGENT_LOOK,
  agentLookFeet,
  parseAgentLook,
  sameAgentLook,
} from '../agent-look'

describe('the look’s lists', () => {
  it('are the package’s shapes and faces, in its order, and every material it draws', () => {
    expect([...AGENT_LOOK_TYPES]).toEqual(botAvatarTypes)
    expect([...AGENT_LOOK_FACES]).toEqual(botAvatarFaces)
    expect([...AGENT_LOOK_SHADINGS].sort()).toEqual(['crisp', 'fabric', 'flat', 'plastic', 'smooth'])
    expect(AGENT_LOOK_SHADINGS[0]).toBe('fabric')
  })

  it('offer only #RRGGBB colours, each with a name, the default’s among them', () => {
    for (const c of [...AGENT_LOOK_BODY_COLORS, ...AGENT_LOOK_ACCESSORY_COLORS]) {
      expect(c).toMatch(/^#[0-9A-F]{6}$/)
      expect(AGENT_LOOK_COLOR_NAMES[c]).toBeTruthy()
    }
    expect(AGENT_LOOK_BODY_COLORS).toContain(DEFAULT_AGENT_LOOK.color)
  })
})

describe('parseAgentLook', () => {
  it('keeps a look made of the lists, the default among them', () => {
    expect(parseAgentLook(DEFAULT_AGENT_LOOK)).toEqual(DEFAULT_AGENT_LOOK)
    expect(parseAgentLook({ type: 'cat', face: 'mouth', glasses: 'shades', hat: 'crown', headphones: false, bowTie: true, color: '#9a62ff', shading: 'plastic' })).toEqual({
      type: 'cat', face: 'mouth', glasses: 'shades', hat: 'crown', headphones: false, bowTie: true, color: '#9A62FF', shading: 'plastic',
    })
    // A look saved before there was a material: fabric.
    expect(parseAgentLook({ type: 'cat', glasses: 'none', hat: 'none', headphones: false, bowTie: false })!.shading).toBe('fabric')
  })

  it('is nothing without a known shape', () => {
    for (const raw of [null, 'triangle', 42, {}, { type: 'dragon' }, { type: ['cat'] }]) expect(parseAgentLook(raw)).toBeNull()
  })

  it('drops what isn’t on the lists, field by field', () => {
    expect(
      parseAgentLook({ type: 'ghost', color: 'red; background:url(x)', face: 'beak', glasses: 'monocle', hat: '<b>', headphones: 'yes', bowTie: 1, accessoryColor: '#12345', shading: 'velvet', extra: 'x' }),
    ).toEqual({ type: 'ghost', glasses: 'none', hat: 'none', headphones: false, bowTie: false, shading: 'fabric' })
  })
})

describe('agentLookFeet', () => {
  it('stands each shape on its base: the triangle’s at 84 of 100, every one low in its box', () => {
    expect(agentLookFeet({ type: 'triangle' })).toEqual({ x: 0.5, y: 0.84 })
    for (const type of AGENT_LOOK_TYPES) {
      const { y } = agentLookFeet({ type })
      expect(y).toBeGreaterThan(0.7)
      expect(y).toBeLessThan(0.95)
    }
  })
})

describe('sameAgentLook', () => {
  it('compares every field, colours in any case', () => {
    expect(sameAgentLook(DEFAULT_AGENT_LOOK, { ...DEFAULT_AGENT_LOOK, color: DEFAULT_AGENT_LOOK.color!.toLowerCase() })).toBe(true)
    expect(sameAgentLook(DEFAULT_AGENT_LOOK, { ...DEFAULT_AGENT_LOOK, hat: 'beret' })).toBe(false)
    expect(sameAgentLook(DEFAULT_AGENT_LOOK, { ...DEFAULT_AGENT_LOOK, color: undefined })).toBe(false)
    // No face is the shape's own, eyes.
    const noFace = { ...DEFAULT_AGENT_LOOK, face: undefined }
    expect(sameAgentLook(noFace, { ...noFace, face: 'eyes' })).toBe(true)
    expect(sameAgentLook(noFace, { ...noFace, face: 'mouth' })).toBe(false)
    // No material is fabric.
    expect(sameAgentLook(DEFAULT_AGENT_LOOK, { ...DEFAULT_AGENT_LOOK, shading: undefined })).toBe(true)
    expect(sameAgentLook(DEFAULT_AGENT_LOOK, { ...DEFAULT_AGENT_LOOK, shading: 'flat' })).toBe(false)
  })
})
