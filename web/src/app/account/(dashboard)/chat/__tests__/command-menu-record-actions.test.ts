/**
 * ⌘K over a record's card: the palette offers that record's own actions (the
 * entity actions menu's, less Open, Rename and Share), and nothing over any
 * other card.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../workspace-switcher', () => ({ useWorkspaceEdition: () => null }))

import { recordActionsFor } from '../command-menu'

const front = (spec: unknown) => ({ id: 'card-1', spec, close: () => {} }) as Parameters<typeof recordActionsFor>[0]

describe('recordActionsFor', () => {
  it("lists a record card's actions that need no more input", () => {
    const source = recordActionsFor(front({ kind: 'record', title: 'Fernhill renewal', record: { type: 'deal', id: 'd-1' } }))
    expect(source?.entity).toEqual({ type: 'deal', id: 'd-1', label: 'Fernhill renewal' })
    expect(source?.actions.map((a) => a.id)).toEqual(['copy_link', 'copy_id', 'make_task'])
  })

  it('offers Archive for a kind that archives', () => {
    const source = recordActionsFor(front({ kind: 'record', title: 'Launch notes', record: { type: 'document', id: 'doc-1' } }))
    expect(source?.actions.map((a) => a.id)).toEqual(['copy_link', 'copy_id', 'make_task', 'archive'])
  })

  it('offers nothing with no card in front, or a card that is not a record', () => {
    expect(recordActionsFor(null)).toBeNull()
    expect(recordActionsFor(front({ kind: 'flows', title: 'Flows' }))).toBeNull()
  })
})
