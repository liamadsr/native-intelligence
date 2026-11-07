# Contributing to Native Intelligence

Thanks for helping build Native Intelligence. Bug fixes, features, docs and tests are
all welcome.

## Before your first pull request: the CLA

Everyone who contributes signs our [Contributor License Agreement](CLA.md) once. It's
based on the Apache Software Foundation's, and it says:

- you keep the copyright to what you contribute, and can use it however you like
- the company that makes Native Intelligence may use and license your contribution
  as part of Native Intelligence: under the [Business Source
  License](LICENSE), under the commercial licenses it sells, and under the Apache
  License once a version moves to it
- what you contribute is yours to give (or your employer agrees)

When you open your first pull request, a bot asks you to sign. Reply on the pull
request with:

> I have read the CLA Document and I hereby sign the CLA

That covers all your future contributions too.

## Making a change

- The web app is in `web/`, the desktop app in `desktop/` and the iPhone and Apple
  Watch apps in `ios/`: see the [README](README.md) for getting each one running.
- Keep a pull request to one change, with tests where the code has them
  (`npm test` in `web/`, `cargo test` in `desktop/src-tauri/`, `Scripts/test-eve-chat.sh`
  in `ios/`).
- Test data uses made-up people, companies and phone numbers (`555-01xx`), never real
  ones.
- Don't commit keys or other secrets, even fake-looking ones outside tests. Turn on the
  leak check once per clone, so a push stops before a key leaves your machine:
  `git config core.hooksPath .githooks` (it needs `gitleaks`: `brew install gitleaks`).
  The same check runs on every push and pull request.
- A security problem goes to a private report, not an issue or pull request: see
  [SECURITY.md](SECURITY.md).
