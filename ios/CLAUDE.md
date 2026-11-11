# CLAUDE.md

Guidance for Claude Code in this repository. `README.md` has the layout and build steps.

## Building

- Simulator builds need no signing, so verify every change with one:
  ```sh
  xcodebuild -project Dial8.xcodeproj -scheme Dial8 -configuration Development \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
  ```
  The `Dial8` scheme also builds the watch app and the widgets.
- To RUN it in the Simulator, sign it ad hoc instead (`CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual
  DEVELOPMENT_TEAM=`): an unsigned app can't use the Keychain, so Supabase can't store the PKCE code
  verifier and Google sign-in fails with "both auth code and code verifier should be non-empty".
- On-device transcription (`SpeechTranscriber`) isn't available in the Simulator; test voice notes on a device.
- Device builds, archives and uploads need Liam's signing identity: leave those to him.
- `project.yml` is the source of truth for the Xcode project. Never hand-edit
  `Dial8.xcodeproj/project.pbxproj`; change `project.yml`, run `xcodegen`, commit both.
  Adding or removing a Swift file needs neither (synchronized folders).
- `Scripts/test-eve-chat.sh` runs the Eve chat contract tests; `Scripts/test-chat-reply-text.sh`
  runs the chat bubble's comment-stripping tests (`Core/Models/ChatReplyText.swift`);
  `Scripts/test-team-chat.sh` runs team chat's rules (`Core/Models/TeamChat/`, Foundation only:
  keep the decisions there, and the Supabase and SwiftUI code in `App/`).
  `Scripts/test-team-calls.sh` runs team calls' rules (`Core/Models/TeamCalls/`: the VoIP push, the
  ring's state machine against CallKit, the call's session and tiles). CallKit and PushKit don't
  deliver in the Simulator: keep their code thin (`App/Services/TeamCalls/`) and the decisions in Core.

## Code

- iOS and watchOS only. There is no macOS target; don't add `#if os(macOS)` branches.
- `Shared/` is compiled into both the app and the widget extension. Keep it to what the widgets need.
- The watch app has no package dependencies and talks to the phone only through WatchConnectivity
  (`Watch/WatchSync.swift` ↔ `App/Services/WatchConnectivityService.swift`).
- Chat runs on the web app's Eve chat agent; the contract is in `docs/ios-eve-chat.md`. The app
  never calls a model provider directly.
- Team chat goes through the web app's team chat routes (the same rules as the web page) and
  reads members, Realtime and files straight from Supabase as the person.
  `-previewTeamChat YES -previewTeamChatScreen <screen>` shows its screens over fixtures (DEBUG).
- Team calls use the same routes (`/api/account/team-calls/*`) and LiveKit's Swift SDK (pinned in
  `project.yml`); CallKit owns the audio session (LiveKit's engine runs only between `didActivate`
  and `didDeactivate`). `-previewTeamCall YES -previewTeamCallScreen <screen>` shows the call screens
  over fixtures (DEBUG).
- New fixtures and examples use made-up names, never real people, customers or companies.
