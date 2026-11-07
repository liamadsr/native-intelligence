# Security

## Reporting a vulnerability

Please don't open a public issue or pull request for a security problem. Report it
privately instead: on this repository's **Security** tab, choose **Report a
vulnerability**. Only the maintainers can see the report.

Include what you found, the steps to reproduce it, and what an attacker could do with
it. A proof of concept helps. We'll acknowledge your report, keep you updated while we
fix it, and credit you when the fix is out unless you'd rather we didn't.

## Scope

- The code in this repository: the web app and its agents (`web/`), the desktop app
  (`desktop/`) and the iPhone and Apple Watch apps (`ios/`).
- The hosted service (dial8.ai, moving to nativeintelligence.dev), as long as you test
  only against your own account and data. Don't access other people's data, degrade the service, or run
  automated scans against it.

Vulnerabilities in a third-party library belong with that library's maintainers. Tell
us too if Native Intelligence is affected in a way that needs a change here.

## Supported versions

Fixes go into `main` and the next release of each app. Older releases don't get
separate patches.
