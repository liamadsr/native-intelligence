# Native Intelligence for iPhone and Apple Watch

The native iOS app, its Apple Watch companion and its widgets. They talk to the same
backend as the web app: the nativeintelligence.dev API for chat, captures and calendar, and Supabase
for sign-in and data.

## Layout

| Folder     | Target          | What it is |
| ---------- | --------------- | ---------- |
| `App/`     | `Dial8`         | The iOS app: screens, recording, transcription, Watch sync |
| `Core/`    | `Dial8`         | Models, API clients, sign-in and config the app is built on |
| `Shared/`  | `Dial8`, `Dial8Widgets` | The Live Activity attributes and the Start Capture intent, which the app and the widgets both compile |
| `Widgets/` | `Dial8Widgets`  | Home screen widget, Live Activity, Control Center control |
| `Watch/`   | `Dial8 Watch`   | The watchOS app: one-press recording, synced to the phone in chunks |
| `Config/`  |                 | The three targets' Info.plist files |
| `Tests/`, `Scripts/` |       | Eve chat contract tests and the script that runs them |
| `docs/`    |                 | How the app talks to the Eve chat backend |

## Build

Requires Xcode 26.2 or later (iOS 26.2, watchOS 11).

```sh
brew install xcodegen   # only needed when project.yml changes
open Dial8.xcodeproj
```

Pick the `Dial8` scheme for the phone (it builds and embeds the watch app and widgets) or
`Dial8 Watch` for the watch. A Simulator build needs no signing:

```sh
xcodebuild -project Dial8.xcodeproj -scheme Dial8 -configuration Development \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

`CODE_SIGNING_ALLOWED=NO` is enough to check that it compiles, but an unsigned app can't use
the Keychain, so sign-in fails when you run it. To run it in the Simulator, sign it ad hoc:

```sh
xcodebuild -project Dial8.xcodeproj -scheme Dial8 -configuration Development \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
```

Xcode does this for you when you press Run.

For a device build, set `DEVELOPMENT_TEAM` in `project.yml` to your own team and change the
bundle IDs to ones you own, then run `xcodegen`.

Xcode Cloud: when the project's team is blank, `ci_scripts/ci_post_clone.sh` fills it in
after the clone from the workflow's secret environment variable `DEVELOPMENT_TEAM_ID`, so
the team never has to be committed.

The project is generated from `project.yml`. Folders are synchronized, so adding or removing
a file needs no project change. Change targets, settings or packages in `project.yml`, then
run `xcodegen` and commit both.

## Configurations

- **Development** uses the development Supabase project and, for chat, `http://localhost:3000`
  (set `NI_API_BASE_URL` in the scheme's environment to reach another backend from a device).
- **Release** uses production and `https://nativeintelligence.dev`.

The Supabase URLs and anon keys in `Core/Config/SupabaseConfig.swift` and the PostHog key in
`Core/Config/PostHogConfig.swift` are public client keys; row-level security protects the data.
To run against your own backend, change those two files.

## Tests

```sh
Scripts/test-eve-chat.sh
Scripts/test-chat-reply-text.sh
Scripts/test-team-chat.sh
Scripts/test-team-calls.sh
```

The first runs the real Swift chat transport against a local fixture server (see
`docs/ios-eve-chat.md`). The second checks how the chat bubble drops HTML comments from a reply.
The third checks team chat's rules on the phone (`Core/Models/TeamChat`): the list's badges, a
send's optimistic bubble reconciled with its row, reactions, mentions, typing, files, and where a
tapped push opens.

## Team chat and push

Team chat (Home's speech-bubble button) talks to the web app's `/api/account/team-chat/*`
routes, the same ones the web page uses, and listens on Supabase Realtime. Its screens can be
seen without signing in, over made-up people, in a Development build:

```sh
xcrun simctl launch <device> com.dial8-iOS-26 -previewTeamChat YES \
  -previewTeamChatScreen list|conversation|focus|thread|mention
```

Push: the app asks for permission the first time team chat opens. On every launch and return
to the foreground it checks Settings: allowed, it registers its APNs token again
(`push_token_register`, migration 562; the server pushes only to installs seen within 30 days);
turned off, it takes the install off (`push_token_remove`). When the session ends, however it
ends, the install is forgotten (`push_token_forget`), and a removal that couldn't reach the server
is done on the next launch before anything is registered.
`Config/Dial8-Development.entitlements` (sandbox) and `Config/Dial8.entitlements`
(production) carry `aps-environment`; the App ID needs the Push Notifications capability.

## Team calls

Calls in a team chat channel or DM (audio, with the camera to turn on), over the web app's
self-hosted LiveKit server, through the same `/api/account/team-calls/*` routes as the web page.
A conversation's phone button starts one (or opens the one the person is in); a call's message has
Join. The call screen shows everyone's camera or face (the one speaking marked, a shared screen on
top), mute, the camera and its flip, where the sound goes (the system's picker: speaker, earpiece,
Bluetooth), ring someone in, and leave; minimised, it is a bar over the app.

Rings reach the phone as calls: the server sends a VoIP push (PushKit, the install's VoIP token,
`push_token_register` with kind `voip`, migration 570) while the ring rings, and a cancel when it
was answered or declined elsewhere or the caller hung up. CallKit shows the call, locked or not;
answering asks the server first (the web's own function), then joins; declining tells the server,
so the web stops ringing. The phone checks every ring against its row (Realtime, else a fetch) and
stops it by its own clock. A ring that arrives while the person is in a call is declined as busy.
Calls stay out of the system's Recents. The VoIP token has the alert token's lifecycle (removed when
the session ends, however it ends), but doesn't depend on notification settings: calls ring like
phone calls.

Their screens can be seen without signing in, in a Development build:

```sh
xcrun simctl launch <device> com.dial8-iOS-26 -previewTeamCall YES \
  -previewTeamCallScreen incoming|pair|call|screen|listening|minimized|ended
```

CallKit and PushKit don't deliver in the Simulator (an incoming ring there shows in the app while it
is open, and a call runs without the system's call screen); a ring as a call needs a device. The
App ID needs the Push Notifications capability (already there for team chat's pushes); VoIP pushes
use the same APNs key, to the topic `<bundle id>.voip`, and need nothing more on Apple's developer
site.

## Third-party code

`THIRD_PARTY_NOTICES.md` lists the code bundled into `App/Resources/EveBotAvatar.html`.

## History

This code moved here on 2026-11-05 from the retired macOS app's repository
(`liamadsr/dial8`, tag `pre-ios-split-2026-11-05`). Its earlier history lives there.
