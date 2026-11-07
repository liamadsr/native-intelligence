/**
 * A work item as a card (the `work_item` page kind, retire-notifications-page
 * phase 3): only the person opens one (show doesn't offer it), and read_card
 * answers it with the item's id for get_bot_item, never "can't open any
 * more" (phase 3 review).
 */
import { describe, expect, it } from 'vitest'
import { buildCardContextEntry, parseCardContext } from '../context'
import { pageTools, seededWorkspace } from './page-fixtures'

const ITEM = '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('work item card', () => {
  it('is never shown by the agent', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'work_item' as never, title: 'Nightly import' })
    expect(out.success).toBe(false)
  })

  it('read_card names the item for get_bot_item', async () => {
    const parsed = parseCardContext([
      buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'work_item', title: 'Nightly import', target: { type: 'work_item', id: ITEM, label: 'Nightly import' } } }),
    ])
    const read = await pageTools(seededWorkspace(), parsed).readCard({ card: 1 })
    expect(read).toMatchObject({ success: true, card: 1, item: ITEM })
    expect(String(read.note)).toContain('get_bot_item')
  })
})
