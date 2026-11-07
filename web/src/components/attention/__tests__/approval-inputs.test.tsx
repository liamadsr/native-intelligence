// @vitest-environment jsdom
/**
 * The approval card's inputs (A5 review): EVERY field of the held call is
 * shown, target-like keys first, in a scrollable box; a long value is clipped
 * per field only, with Show all; the card's words say what is shown.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { ApprovalInputs } from '../approval-inputs'
import { APPROVAL_FIELD_CLIP_CHARS, approvalInputFields } from '@/lib/attention/approval-input'
import { cardEffectLine, cardPrimaryLabel } from '@/lib/attention/card-copy'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null
function mount(input: unknown): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(h(ApprovalInputs, { input })))
  return container
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('approvalInputFields', () => {
  it('lists every field, target-like keys first (to, recipient, email, url, project, team, id), then alphabetically', () => {
    const fields = approvalInputFields({ body: 'Hi', zeta: 1, action_id: 'GEN-1', to: 'eve@example.com', url: 'https://x.test', project: 'Web', alpha: true })
    expect(fields.map((f) => f.key)).toEqual(['to', 'url', 'project', 'action_id', 'alpha', 'body', 'zeta'])
    expect(fields.filter((f) => f.target).map((f) => f.key)).toEqual(['to', 'url', 'project', 'action_id'])
  })

  it('shows values whole: strings as is, anything else as indented JSON', () => {
    expect(approvalInputFields({ list: [1, 2] })[0].value).toBe('[\n  1,\n  2\n]')
    expect(approvalInputFields('raw')).toEqual([{ key: 'input', value: 'raw', target: false }])
    expect(approvalInputFields(null)).toEqual([])
  })
})

describe('<ApprovalInputs>', () => {
  it('renders every field in a scrollable box, the long one clipped with Show all', () => {
    const long = 'x'.repeat(APPROVAL_FIELD_CLIP_CHARS + 50)
    const el = mount({ to: 'eve@example.com', body: long })
    const box = el.querySelector('[data-approval-inputs]') as HTMLElement
    expect(box.className).toContain('overflow-y-auto')
    expect(el.querySelectorAll('[data-approval-field]')).toHaveLength(2)
    expect(el.querySelector('[data-approval-field="to"]')!.textContent).toContain('eve@example.com')
    const body = el.querySelector('[data-approval-field="body"] dd')!
    expect(body.textContent!.length).toBe(APPROVAL_FIELD_CLIP_CHARS + 1)
    act(() => (el.querySelector('[data-approval-field="body"] button') as HTMLButtonElement).click())
    expect(el.querySelector('[data-approval-field="body"] dd')!.textContent).toBe(long)
  })
})

describe('approval card copy', () => {
  it('says what the card shows', () => {
    expect(cardPrimaryLabel({ kind: 'approval' }, {})).toBe('Approve')
    expect(cardEffectLine({ kind: 'approval', title: 't' }, { tool: 'delete_action' } as never)).toBe('Runs delete_action once, with exactly the inputs shown')
  })
})

describe('<ApprovalInputs> and session replay', () => {
  it('the inputs box carries ph-no-capture (a held email send shows its subject and body)', () => {
    const el = mount({ to: 'eve@example.com', subject: 'Pricing', body: 'Hi Eve' })
    expect((el.querySelector('[data-approval-inputs]') as HTMLElement).classList.contains('ph-no-capture')).toBe(true)
  })
})
