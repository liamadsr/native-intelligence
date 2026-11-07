import { describe, expect, it } from 'vitest'
import { browserTypeStateKey, rememberBrowserTypeRefusal, unavailableBrowserTypeRefs } from '../type-recovery'
import type { BrowserObservation } from '../task-contract'

const observation: BrowserObservation = { protocol: 'dial8-browser-decision-v1', documentId: 'document', observationId: 1,
  interactionEpoch: 0, observedAt: 1, url: 'https://example.com/', title: '', text: '', elements: [
    { ref: 'e1', role: 'combobox', name: 'Selected group', value: 'Group', context: 'Exact item', canType: true,
      forbidden: false, disabled: false, sensitive: false, destination: '', expanded: 'false' },
  ] }
describe('identical field refusal recovery', () => {
  it('suppresses only the identical live field state and allows changes or new documents', () => {
    const keys = rememberBrowserTypeRefusal(observation, 'e1', undefined)
    expect(unavailableBrowserTypeRefs({ ...observation, observationId: 2, observedAt: 2 }, keys)).toEqual(['e1'])
    for (const change of [{ value: 'Changed' }, { name: 'Different entity' }, { context: 'New context' }, { expanded: 'true' as const }])
      expect(unavailableBrowserTypeRefs({ ...observation, elements: [{ ...observation.elements[0], ...change }] }, keys)).toEqual([])
    expect(unavailableBrowserTypeRefs({ ...observation, documentId: 'new-document' }, keys)).toEqual([])
    expect(unavailableBrowserTypeRefs({ ...observation, url: 'https://example.com/new' }, keys)).toEqual([])
    expect(unavailableBrowserTypeRefs(observation, ['e1', 'fake', {}, null])).toEqual([])
  })
  it('bounds persisted hashes and excludes disabled, forbidden or noneditable fields', () => {
    const prior = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(64, '0'))
    expect(rememberBrowserTypeRefusal(observation, 'e1', prior)).toHaveLength(8)
    for (const change of [{ disabled: true }, { forbidden: true }, { canType: false }])
      expect(browserTypeStateKey({ ...observation, elements: [{ ...observation.elements[0], ...change }] }, 'e1')).toBeNull()
  })
})
