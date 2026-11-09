# iOS Eve chat

The iOS conversation UI uses `iOSEveChatViewModel` and `EveChatSession`. Existing native consumers of `AIBackendService.sendMessageStreaming` also use the same Eve transport. There are no remaining calls to the retired `/api/ai/chat` or `/api/ai/summarize` routes in Swift.

## Backend contract

1. Mint a conversation run token at `/api/account/chat/eve-session` with the selected teammate or recipe persona.
2. Create a message-free `/eve/chat-agent/v1/session` when needed, then register its ID before sending or streaming. This satisfies the web backend's ownership checks.
3. Submit only the newest message. Eve owns conversation history, tool execution, approvals, and usage accounting. Model and capture context travel in `x-chat-run-ctx`; every call carries the workspace and signed-in user's bearer token.
4. Read the NDJSON stream by event index, filter by accepted delivery ID, and project text, reasoning, tools, and input requests. Versions 21–26 are supported (`EveTurnProjection.supportedStreamVersions`); newer versions require an explicit client update. In v26 a question inside a turn pauses it with `turn.waiting` instead of ending it: the client stops reading there only while a question is pending (`turn.waiting` also fires while a turn waits on its own tasks), and the answer resumes the same turn. A tool that runs as a task answers with a receipt, and its result arrives in `task.settled`.
5. Save accepted user input promptly, then save the completed reply through `/api/account/chat/eve-persist`. Stable UI message IDs let the backend deduplicate these writes.

Stream reconnects retry reads only. An ambiguous send acknowledgment is reconciled against the durable stream before allowing another send. Stop targets the observed turn ID. Approvals use the exact server option/request IDs; `ask_user` text is also carried in `clientContext`, as required by Eve's tool-approval protocol.

Each session is bound to its original account. Workspace/sign-out changes reset native conversation state. Restoring an existing conversation reads a bounded durable snapshot before attaching to live events, so unanswered requests survive relaunch.

## Agents and history

- Workspace teammates come from `/api/account/agent-work?light=1`. Selecting one opens its canonical thread with the `thread` action on the Eve session endpoint.
- Recipe rows in the `agent` category appear as personas; the mint endpoint revalidates access to the selected recipe.
- History reads the same `chat_conversations` and `chat_messages` tables as the website. Old `agent_threads` and `agent_messages` remain readable and are used as a bounded primer when continued in Eve.
- Persona selection is remembered locally per account/conversation. The current web conversation schema does not persist that selection across devices.

The recording flow already uses the Eve-backed `/api/ai/live-agent` route. Speech transcription, embeddings, and search are separate services and were not redirected to the conversational agent. Legacy provider implementations remain for other native features/platforms; the iOS model manager does not register them as chat providers.

## Avatars

`EveBotAvatar.html` bundles the website's actual `BotRig`, built-in characters, and custom bot composition logic. It runs offline in an isolated `WKWebView` without authentication or remote scripts. The conversation/profile avatar preserves idle movement, hops, tap reactions, and the working state. Reduced Motion and backgrounding pause animation. Picker rows use cached still images from one offscreen renderer.

The committed bundle was exported from the website's Eve-era bot renderer with `bot-avatars` 0.1.1. The export script (`scripts/export-ios-bot-avatar.mjs` in the website) was never committed, so the bundle can't be regenerated as it is: changing the bot artwork means writing that export again. `THIRD_PARTY_NOTICES.md` lists the code inside the bundle.

The interaction reference is OpenAI's [Your Dot profile guidance](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot): select the agent and tap its avatar/name to see its profile. The artwork and animation are Native Intelligence's own web implementation.

## Development and verification

Development chat defaults to `http://localhost:3000`; set the Xcode launch environment variable `DIAL8_API_BASE_URL` to a reachable backend when using a physical device. The backend must use the same Supabase environment as the app. Production builds use `https://dial8.ai`.

```sh
Scripts/test-eve-chat.sh
xcodebuild -project Dial8.xcodeproj -scheme Dial8 \
  -configuration Development -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/dial8-eve-build ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO build
```

Contract tests run the real Swift transport against a local fixture server. They cover versioned projections, replay deduplication, mint/register/send ordering, account and workspace checks, delivery filtering, cursor reconnects, uncertain acknowledgments, retired sessions, persistence, pending approvals, and usage denial.

DEBUG launch argument `-previewEveChat` opens the actual chat UI with local fixture data. Add `-previewEveAgentPicker` or `-previewEveAgentProfile` to preview those sheets without calling a model. These are visual fixtures, not evidence of an authenticated server conversation.

Verified on 2026-10-04: Development iOS simulator build, local contract suite, simulator chat/picker/profile rendering, and read-only DEV/PRD database schema compatibility. An authenticated real-user Eve turn and physical-device run remain unverified. No backend deployment or database migration is required by these native changes.
