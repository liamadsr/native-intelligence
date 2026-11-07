/**
 * Static guard for a bug class only a real GPU driver reports.
 *
 * In GLSL ES 3.00 a uniform declared in BOTH stages of a program must have the
 * same precision in each, or the program fails to LINK. The defaults differ:
 * vertex shaders default `int` and `float` to highp; fragment shaders have no
 * default `float` precision (ours declare `precision mediump float`) and
 * default `int` to mediump. So `uniform int uFlag;` written identically in
 * both stages is a link error — found in a browser, invisible to jsdom.
 *
 * Rule enforced here: a uniform that appears in both stages must spell out its
 * precision, identically, in both.
 */

import { describe, expect, it } from 'vitest'

import * as shaders from '../shaders'

interface UniformDecl {
  name: string
  precision: string | null
  type: string
}

function uniformsOf(source: string): Map<string, UniformDecl> {
  const out = new Map<string, UniformDecl>()
  const re = /^\s*uniform\s+(?:(lowp|mediump|highp)\s+)?(\w+)\s+(\w+)/gm
  for (const m of source.matchAll(re)) {
    out.set(m[3], { name: m[3], precision: m[1] ?? null, type: m[2] })
  }
  return out
}

const sources = shaders as unknown as Record<string, unknown>
const programs = Object.keys(sources)
  .filter((k) => k.endsWith('_VS') && typeof sources[k] === 'string')
  .map((vs) => ({ name: vs.slice(0, -3), vs: sources[vs] as string, fs: sources[`${vs.slice(0, -3)}_FS`] }))
  .filter((p): p is { name: string; vs: string; fs: string } => typeof p.fs === 'string')

describe('shader programs link-safety', () => {
  it('finds every program pair', () => {
    expect(programs.map((p) => p.name).sort()).toEqual(['EDGE', 'LABEL', 'NODE', 'RING'])
  })

  it.each(programs)('$name: uniforms shared by both stages declare one explicit precision', ({ vs, fs }) => {
    const v = uniformsOf(vs)
    const f = uniformsOf(fs)
    for (const [name, decl] of v) {
      const other = f.get(name)
      if (!other) continue
      // Samplers have fixed default precision rules of their own; opaque types
      // are never shared across stages here, so only numeric types matter.
      expect(decl.type, `${name} type`).toBe(other.type)
      expect(decl.precision, `${name} needs an explicit precision in the vertex shader`).not.toBeNull()
      expect(other.precision, `${name} needs an explicit precision in the fragment shader`).not.toBeNull()
      expect(decl.precision, `${name} precision must match across stages`).toBe(other.precision)
    }
  })
})
