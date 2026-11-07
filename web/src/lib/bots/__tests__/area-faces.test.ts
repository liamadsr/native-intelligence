/**
 * An area face's page knows its area (area-faces.ts areaOfTeammate).
 */
import { describe, it, expect } from 'vitest'
import { areaOfTeammate } from '../area-faces'

describe('areaOfTeammate', () => {
  it('is an area face’s area, and nothing for the Assistant or any other bot', () => {
    expect(areaOfTeammate({ is_system: true, system_key: 'captures' })).toBe('captures')
    expect(areaOfTeammate({ is_system: true, system_key: 'assistant' })).toBeNull()
    expect(areaOfTeammate({ is_system: false, system_key: 'mail' })).toBeNull()
    expect(areaOfTeammate({ is_system: true, system_key: 'triage' })).toBeNull()
    expect(areaOfTeammate(null)).toBeNull()
  })
})
