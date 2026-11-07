// @vitest-environment jsdom
/**
 * "Learn about my company" — the door from the Prospecting empty state into
 * Scout, the prospecting agent.
 *
 * WHY IT IS IN BOTH STATES. The two empty states are the two ways a workspace
 * arrives here, and the guided path has to exist on both or it is only ever
 * offered to whichever half of users the page happens to catch:
 *
 *  1. NO source company. Typing a domain into the form is the manual path; the
 *     button beside it is the one that reads as "ask me instead". Without it,
 *     the workspaces whose enrichment hung in production (§10, the reason this
 *     state is REQUIRED rather than optional) are handed a blank form and no
 *     agent.
 *  2. A source company already researched. This is the PRIMARY button now, and
 *     the reversal is the point: "Who should we find?" is a QUESTION, and the
 *     four starter cards below it cannot answer a question — they are
 *     templates, and pressing one requires the user to already know which of
 *     investors/customers/partners they want and how to phrase it. A
 *     conversation is the only thing on the screen that can take the question
 *     as asked, so it is the default and the grid becomes "or start one
 *     yourself". Nothing was removed to make room: every card, the custom box,
 *     and the "Research my company" link all still work untouched.
 *
 * WHAT THE DETAIL CARRIES, and why each half matters:
 *
 *  - `domain` is the SUGGESTED domain in the no-source state, never the live
 *    field. The field is the user mid-keystroke: a half-typed 'dial8.a' sends
 *    Scout to research the wrong company, whereas null makes it ask. In the
 *    company-card state it is the resolved row's own domain.
 *  - `sourceEstablished` tells Scout whether `research_my_company` has anything
 *    to resolve, i.e. whether its first move costs money. Getting this wrong is
 *    a spend bug, not a copy bug.
 *
 * The event is dispatched, never a navigation: chat shares the tab the user is
 * on, so the list Scout builds lands on the screen they are already looking at.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../list-detail', () => ({ ListDetail: () => null }))

/**
 * The dispatcher is stubbed rather than spying on `window.dispatchEvent`.
 *
 * This suite owns the CALL — that the button is wired to the helper with the
 * right context — and Package B's own suite owns the event that helper emits
 * (its name, and that the shell's listener picks it up). Asserting the wire
 * format here would pin the same contract in two places, so a rename of the
 * event would fail two suites for one change and neither would be the one that
 * describes it.
 */
const startProspectingChat = vi.fn()
vi.mock('../start-event', () => ({
  startProspectingChat: (ctx: unknown) => startProspectingChat(ctx),
}))

const fetchLists = vi.fn(async () => [] as unknown[])
const fetchSource = vi.fn()
const researchSource = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchLists: () => fetchLists(),
    fetchSource: () => fetchSource(),
    researchSource: (domain?: string | null) => researchSource(domain),
  }
})

import { ProspectingView } from '../prospecting-view'
import { CARDED_COMPANY, UNCARDED_COMPANY, sourcePayload } from './fixtures'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fetchLists.mockClear().mockResolvedValue([])
  fetchSource.mockReset()
  researchSource.mockReset()
  startProspectingChat.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render() {
  await act(async () => {
    root.render(<ProspectingView listId={null} onOpenList={noop} onCloseDetail={noop} />)
  })
  // The lists and the source resolve on separate promises.
  await act(async () => {})
}

function buttonWithText(needle: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(needle),
  )
}

function learnButton(): HTMLButtonElement | undefined {
  return buttonWithText('Learn about my company')
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Learn about my company', () => {
  describe('with no source company', () => {
    it('offers the guided path beside the domain form', async () => {
      fetchSource.mockResolvedValue(sourcePayload(null, 'dial8.ai'))
      await render()

      // Both paths, on the same card: the form for anyone who would rather
      // type, the button for anyone who would rather be asked.
      expect(container.querySelector('#prospecting-source-domain')).toBeTruthy()
      expect(learnButton()).toBeTruthy()
      // This branch was ALREADY primary and is untouched by the company-card
      // change — pinned so a future edit cannot demote the only agent door on
      // the state that exists because enrichment hung.
      expect(learnButton()!.className).toContain('bg-primary')
    })

    it('hands Scout the suggested domain and says the source is not established', async () => {
      fetchSource.mockResolvedValue(sourcePayload(null, 'dial8.ai'))
      await render()

      await act(async () => click(learnButton()!))

      expect(startProspectingChat).toHaveBeenCalledTimes(1)
      expect(startProspectingChat).toHaveBeenCalledWith({
        domain: 'dial8.ai',
        // The row does not exist yet, so Scout's first move is a real spend
        // and it must know that before it quotes.
        sourceEstablished: false,
      })
    })

    it('sends a null domain when there is nothing to suggest', async () => {
      // A personal/webmail signup gets `suggested_domain: null`. Null is the
      // honest hand-over: the agent asks (ask_user) rather than researching a
      // company nobody named.
      fetchSource.mockResolvedValue(sourcePayload(null))
      await render()

      await act(async () => click(learnButton()!))

      expect(startProspectingChat).toHaveBeenCalledWith({
        domain: null,
        sourceEstablished: false,
      })
    })

    it('sends the suggestion, not the half-typed field', async () => {
      // THE SPEND TRAP. The field is the user mid-edit; 'dial8.a' is a real
      // domain-shaped string that resolves to the wrong company, and a wrong
      // company is money spent researching somebody else's business. Null and
      // the suggestion are both recoverable — a wrong domain is not.
      fetchSource.mockResolvedValue(sourcePayload(null, 'dial8.ai'))
      await render()

      const input = container.querySelector<HTMLInputElement>('#prospecting-source-domain')!
      await act(async () => typeInto(input, 'dial8.a'))
      await act(async () => click(learnButton()!))

      expect(startProspectingChat).toHaveBeenCalledWith({
        domain: 'dial8.ai',
        sourceEstablished: false,
      })
    })

    it('leaves the domain form working', async () => {
      // Nothing is removed. The typing path is still a real submit.
      fetchSource.mockResolvedValue(sourcePayload(null))
      researchSource.mockResolvedValue({
        ...sourcePayload(UNCARDED_COMPANY),
        established: true,
        enrichment: 'started' as const,
      })
      await render()

      const input = container.querySelector<HTMLInputElement>('#prospecting-source-domain')!
      await act(async () => typeInto(input, 'dial8.ai'))
      await act(async () => click(buttonWithText('Use this company')!))
      await act(async () => {})

      expect(researchSource).toHaveBeenCalledWith('dial8.ai')
      expect(startProspectingChat).not.toHaveBeenCalled()
    })
  })

  describe('with a source company', () => {
    it('offers the same door as the PRIMARY action on the company card', async () => {
      fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
      await render()

      const button = learnButton()
      expect(button).toBeTruthy()
      // The `primary` variant is a real filled Button; the `quiet` one is a
      // bare text button. Distinguishing them by the shipped class is what
      // stops this silently reverting to a link nobody sees under the four
      // cards it is meant to lead.
      expect(button!.className).toContain('bg-primary')
    })

    it('names the starter grid as the alternative it now is', async () => {
      // Without this line the card ends on a filled button and the grid opens
      // with four more things to press: two competing primary paths, neither
      // named as a path. One muted sentence is the whole difference between
      // "here is the way in, or do it yourself" and "pick one of five".
      fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
      await render()

      expect(container.textContent).toContain('or start one yourself')
    })

    it('hands Scout the resolved domain and says the source IS established', async () => {
      fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
      await render()

      await act(async () => click(learnButton()!))

      expect(startProspectingChat).toHaveBeenCalledTimes(1)
      expect(startProspectingChat).toHaveBeenCalledWith({
        domain: 'dial8.ai',
        // Established: `research_my_company` resolves the existing row and
        // returns the profile without spending.
        sourceEstablished: true,
      })
    })

    it('is offered even before the ICP card has run, alongside Research my company', async () => {
      // The two controls answer different questions — one fires the $0.01 card
      // on a company we already have, the other opens a conversation — so an
      // uncarded company gets both rather than being made to choose blind.
      fetchSource.mockResolvedValue(sourcePayload(UNCARDED_COMPANY))
      await render()

      expect(buttonWithText('Research my company')).toBeTruthy()
      expect(learnButton()).toBeTruthy()

      await act(async () => click(learnButton()!))
      expect(startProspectingChat).toHaveBeenCalledWith({
        domain: 'dial8.ai',
        sourceEstablished: true,
      })
      // The button is a hand-off, not a spend: it must not fire the card.
      expect(researchSource).not.toHaveBeenCalled()
    })

    it('leaves the starter cards alone', async () => {
      // The button is additive. Every existing way out of this screen stays.
      fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
      await render()

      for (const label of ['Customers', 'Investors', 'Partners']) {
        expect(buttonWithText(label), `starter card: ${label}`).toBeTruthy()
      }
      expect(container.querySelector('#prospecting-custom-target')).toBeTruthy()
    })
  })
})
