import { describe, it, expect } from 'vitest'
import { SURFACE_MODELS, surfaceModel, surfaceModelSlug } from '@/lib/ai/model-defaults'
import { ALLOWED_MODELS, DEFAULT_MODEL, STRONG_MODEL, getModelProvider } from '@/lib/ai/models'

describe('SURFACE_MODELS (one fixed model per surface: nobody picks)', () => {
  it('runs every routine surface on Flash and the constrained ones on the Strong model', () => {
    expect(SURFACE_MODELS).toEqual({
      live_agent: DEFAULT_MODEL,
      device_ask: DEFAULT_MODEL,
      skill_runs: DEFAULT_MODEL,
      work_agent: DEFAULT_MODEL,
      knowledge: DEFAULT_MODEL,
      drafting: DEFAULT_MODEL,
      document_ingest: STRONG_MODEL,
      coding_runs: STRONG_MODEL,
    })
  })

  it('every surface model is a real catalog id; coding and PDF ingest run Anthropic (they read PDFs and code)', () => {
    for (const model of Object.values(SURFACE_MODELS)) expect(ALLOWED_MODELS.has(model)).toBe(true)
    expect(getModelProvider(surfaceModel('coding_runs'))).toBe('anthropic')
    expect(getModelProvider(surfaceModel('document_ingest'))).toBe('anthropic')
  })

  it('gives the Gateway catalog slug, never a hand-built provider/id', () => {
    expect(surfaceModelSlug('knowledge')).toBe('deepseek/deepseek-v4-flash')
    expect(surfaceModelSlug('coding_runs')).toBe('anthropic/claude-sonnet-5.5')
  })

  it('has no chat surface: the main chat\'s model is the turn\'s tier (model-route.ts)', () => {
    expect('chat' in SURFACE_MODELS).toBe(false)
    expect('crm_enrichment' in SURFACE_MODELS).toBe(false)
  })
})
