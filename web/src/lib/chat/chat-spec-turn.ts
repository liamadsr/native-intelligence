/**
 * The per-turn context a chat spec request carries as a base64url-encoded
 * JSON `ctx` query param (the volatile half of the durable-vs-per-turn split,
 * src/lib/chat/chat-run-token.ts): read the same way by the cloud body's
 * /api/internal/chat/spec and the Mac body's /api/local-agent/agent/spec.
 */
import { parseTurnRouteSignals } from '@/lib/ai/model-route'
import type { ChatSpecTurnContext } from './chat-run-rebuild'

/**
 * Decode `ctx`. A malformed or absent one degrades to an empty turn context
 * (base prompt + persona only), never a 500.
 */
export function decodeChatTurnContext(raw: string | null): ChatSpecTurnContext {
  try {
    if (!raw) return {}
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    // Shape guard: only pass through the known volatile fields.
    if (parsed && typeof parsed === 'object') {
      return {
        // An older client may still send `searchSettings` (the removed "My
        // captures" picker): it is not read. The agent picks each search's
        // scope itself (src/lib/ai/tools/search-scope.ts).
        systemContext: parsed.systemContext,
        // The message's routing signals (src/lib/ai/model-route.ts). An older
        // client's `model` and `thinking` are not read: nobody picks a model.
        route: parseTurnRouteSignals(parsed.route),
      }
    }
    return {}
  } catch {
    // Best-effort — a bad ctx degrades to an empty turn context, never a 500.
    return {}
  }
}
