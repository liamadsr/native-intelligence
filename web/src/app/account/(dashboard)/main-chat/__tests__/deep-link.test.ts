/**
 * The boot deep links (main-chat-context.tsx deepLinkCard): a team chat
 * email's link opens team chat on its message, in the workspace the link
 * names (the main chat switches to it first, as for any card asked for in
 * another workspace); a link without one opens where the person is.
 */
import { describe, expect, it } from 'vitest'
import { deepLinkCard, DEEP_LINK_WORKSPACE } from '../main-chat-context'

const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WS = '11111111-1111-4111-8111-111111111111'

describe('deepLinkCard', () => {
  it('a team chat message, in its workspace: team chat opened on it, the workspace carried with the card', () => {
    const link = deepLinkCard(new URLSearchParams(`team_chat_message=${MSG}&${DEEP_LINK_WORKSPACE}=${WS}`))
    expect(link).toEqual({
      param: 'team_chat_message',
      request: { spec: { kind: 'team_chat', title: 'Team chat' }, from: 'link', seed: { at: { type: 'team_chat_message', id: MSG } }, workspaceId: WS },
    })
  })

  it('no workspace, or one that isn’t an id: where the person is', () => {
    expect(deepLinkCard(new URLSearchParams(`team_chat_message=${MSG}`))?.request.workspaceId).toBeUndefined()
    expect(deepLinkCard(new URLSearchParams(`team_chat_message=${MSG}&workspace=nope`))?.request.workspaceId).toBeUndefined()
  })
})
