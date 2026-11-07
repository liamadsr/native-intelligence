# Native Intelligence

Native Intelligence is a workspace with an AI agent in the middle of it. It captures
your meetings and calls, keeps your email, calendar, projects and customers in one
place, and the agent works across all of it: in chat, by text and over the phone.

| Folder | What's in it |
| --- | --- |
| [`web/`](web/) | The web app (Next.js): the dashboard, its API, the AI agents, the database migrations (Supabase), the marketing site and the docs. [`web/CLAUDE.md`](web/CLAUDE.md) walks through the code. |
| [`desktop/`](desktop/) | The desktop app (Tauri, Rust): it opens the web app and adds audio capture, meeting detection, on-device transcription and read-aloud. [`desktop/README.md`](desktop/README.md) covers building it. |
| [`ios/`](ios/) | The iPhone and Apple Watch apps (Swift, SwiftUI): captures with on-device transcription, chat with the agent, widgets and a Live Activity, and one-press recording on the watch. [`ios/README.md`](ios/README.md) covers building it. |

## Getting started

The web app needs Node 24 (`web/.nvmrc`), a Supabase project, and service keys in
`web/.env.local`.

```bash
cd web
npm install
npm run dev     # http://localhost:3000
npm test
```

The desktop app runs against that dev server. Its speech engines are submodules: from
the top of the repo, `GIT_LFS_SKIP_SMUDGE=1 git submodule update --init`.

The iOS app builds in Xcode (`ios/Dial8.xcodeproj`); a Simulator build needs no signing.

## One repo, older names

Native Intelligence used to be called Dial8, and `web/`, `desktop/` and `ios/` started
as three repos, `dial8-website`, `dial8-desktop` and `dial8-ios`. Code, comments and scripts still use those
names in places. Where `desktop/README.md` says `cd ../dial8-website`, it's `cd ../web`
here. The desktop's `scripts/local-agent-bundle.sh` looks for the website beside it: run
it from `desktop/` with `DIAL8_WEB_DIR=../web`.

Comments in the code sometimes point to notes under `web/docs/` (`docs/plans/...` and
the like) that aren't in this repo. They were the team's internal working notes. The
developer guides in `web/docs/` are the ones that ship.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: everyone signs
our [Contributor License Agreement](CLA.md) once, on their first pull request.

## Security

Found a security problem? Don't open an issue: report it privately, as
[SECURITY.md](SECURITY.md) explains.

## License

Native Intelligence is source-available under the [Business Source License 1.1](LICENSE),
which isn't an open-source license. You can read the code, change it, test it, contribute
to it, and run your own instance of it for your personal use, as long as you don't charge
anyone for it. Running it for a company, or charging for it, takes a commercial license
from us: [get in touch](https://nativeintelligence.dev/contact).

Four years after each version is published, that version moves to the Apache License
2.0.

Some files aren't covered by that license and keep their own:

- Parts of the web app's UI, the marketing site among them, come from
  [Tailwind UI](https://tailwindui.com) and are used under the Tailwind UI license. Using
  them outside Native Intelligence takes a Tailwind UI license of your own.
- The Inter and Noto Serif fonts in `web/packages/ui/fonts/` are under the SIL Open Font
  License, with their license files beside them.
- The desktop's speech engines (submodules) and the other third-party code in `desktop/`
  say what license they're under in their own folders (`UPSTREAM.md` files and
  `licenses/` folders).
- The iOS app's bot avatar bundle (`ios/App/Resources/EveBotAvatar.html`) includes
  bot-avatars and React, under the MIT License: see `ios/THIRD_PARTY_NOTICES.md`.

The license doesn't cover the Native Intelligence name or logo.
