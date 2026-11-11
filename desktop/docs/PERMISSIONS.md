# macOS Permissions & TCC — how Native Intelligence keeps microphone / audio grants stable

This document exists because a permission-flow breakage was expensive to
diagnose. Read it before touching anything that signs the app, changes the
bundle identifier, or changes what the app records. The short version:

- **The production app must always be signed with our Developer ID** so its
  microphone grant persists across updates.
- **Dev/debug builds must ALSO be signed with the same Developer ID** — an
  ad-hoc dev build silently poisons the production app's microphone grant and
  makes macOS re-prompt the real user.
- **Debug builds must never run the auto-updater** — it silently swaps the
  debug bundle for the notarized production app on disk, which breaks TCC's
  static-code validation mid-session and silently kills the mic (see "The dev
  auto-update poisoning" below). The updater plugin is only registered under
  `#[cfg(not(debug_assertions))]` in `src-tauri/src/lib.rs`.
- `release.sh` now asserts the signing invariants post-sign; `build.sh` and
  `dev.sh` now sign debug bundles.

## How macOS TCC keys a permission grant

TCC (Transparency, Consent, Control) stores each grant in a `TCC.db` row keyed
by a **service** plus a **client identifier** plus a **code-signing requirement
(csreq)**. The csreq is a blob captured from the code signature of *whichever
binary was running when the grant was made*. On the next access, macOS
re-evaluates the current binary's signature against the stored csreq; if it no
longer satisfies it, the grant is treated as belonging to a *different* program
and the user is prompted again.

Two services matter for Native Intelligence, and they are keyed differently:

| Service | TCC key | Grants persist as long as… |
| --- | --- | --- |
| `kTCCServiceMicrophone` | **Bundle ID** (`ai.dial8.desktop`) + csreq | bundle id and csreq stay stable |
| `kTCCServiceAudioCapture` | **binary Path** (`/Applications/Native Intelligence.app/...`) + csreq | the path and csreq stay stable |

The microphone row is the fragile one: it is keyed by bundle ID, and *every*
build that declares `CFBundleIdentifier = ai.dial8.desktop` competes for the
same row. The Audio Capture row is keyed by path, so a dev build living under
`src-tauri/target/debug/...` can't collide with the production path.

> **Keying update (observed Aug 12 2026, macOS 25.x):** the unified log now
> shows `kTCCServiceAudioCapture` Delete/Create events with
> `identifier_type = Bundle ID` — i.e. on current macOS the Audio Capture row
> is **bundle-ID-keyed like the mic row**, shared by production and every dev
> build, not path-keyed as the July 2026 incident recorded. tccd was also seen
> maintaining *additional path-keyed microphone rows* for the debug binary.
> Treat the table above as historical; verify keying with the unified log
> (`Publishing <TCCDEvent: ...>` lines) before reasoning from it.

A stable csreq means a **stable designated requirement (DR)**. Our production DR
(from a Developer ID signature) is:

```
designated => identifier "ai.dial8.desktop" and anchor apple generic
  and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */
  and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */
  and certificate leaf[subject.OU] = "<TEAM_ID>"
```

Because that DR references the team OU and not a specific hash, it is identical
across versions — so a properly-signed update does **not** re-prompt.

## Where Native Intelligence actually prompts (prompt origins in this codebase)

The native code requests two TCC-gated capabilities, microphone and Audio
Capture, and both prompts originate in the **main process** (`dial8-desktop`),
never the sidecar. The native code never requests screen recording.

Team calls (the web app's calls between people, in the main window's web view)
add the **camera** (`kTCCServiceCamera`): WebKit asks for it when a person turns
their camera on in a call (`getUserMedia`; wry grants the web view's own
request, then macOS prompts once for the app). It needs
`NSCameraUsageDescription` in `Info.plist` (merged into the bundle by
`release.sh`, which refuses a bundle without it: macOS kills a process that
touches the camera without one) and `com.apple.security.device.camera` in both
entitlements files (the hardened runtime refuses the camera without it). The
call's microphone is the same `kTCCServiceMicrophone` grant as above. Sharing a
screen in a call uses `getDisplayMedia`, which shows macOS's own content picker;
that path has not been tried by hand in the app yet.

- **Microphone (`kTCCServiceMicrophone`)** — triggered when the main process
  opens the input device via `cpal`'s `build_input_stream`
  (`src-tauri/src/audio/mic_capture.rs`, driven by the `start_recording` command
  in `src-tauri/src/commands/recording.rs`).
- **System audio (`kTCCServiceAudioCapture`)** — requested deliberately with
  the private `TCCAccessRequest` (`src-tauri/src/native/tcc_helper.m`, driven by
  the `request_system_audio_permission` command). Creating the Core Audio
  process tap (`AudioHardwareCreateProcessTap` in
  `src-tauri/src/native/tap_helper.m`) neither prompts nor fails when the
  permission is missing: macOS enforces it only when IO starts on the
  tap-backed aggregate device, so if nothing asked first, that is where the OS
  prompts. See "System audio permission is checked with
  TCCAccessPreflight/TCCAccessRequest" below.
- **The Swift sidecar (`system-audio-capture`) never prompts under its own
  identity.** It only reads PCM from the aggregate/tap device that the main
  process already created. Starting IO on that device is where macOS enforces
  Audio Capture, but the access is attributed to the responsible parent app,
  not to the sidecar. This is why the sidecar's own signing identifier is
  irrelevant to permissions (see "The harmless sidecar identifier" below).

## Why dev builds used to cause "permission re-asked after update"

A Tauri **debug** build (`cargo tauri build --debug`, what `build.sh dev` and
`dev.sh` produce) is **ad-hoc, linker-signed**:

```
CodeDirectory ... flags=0x20002(adhoc,linker-signed)
Signature=adhoc
TeamIdentifier=not set
designated => cdhash H"a9489445d69ee7ffbfde89f3dc63ea0316ec38ac"
```

Its Info.plist still declares `CFBundleIdentifier = ai.dial8.desktop`, so when a
dev build records audio, TCC writes the shared `ai.dial8.desktop` microphone row
with **that build's per-cdhash requirement**. The production app
(`/Applications/Native Intelligence.app`, Developer ID, stable DR above) then fails the csreq
match on its next microphone access and macOS **re-prompts** the user.

### Evidence (unified log, Jul 9 2026)

- **18:13** — a dev build prompts and gets granted; TCC writes a `Create` row for
  `kTCCServiceMicrophone`, `identifier_type = Bundle ID`, keyed to the dev
  build's ad-hoc cdhash. (`AUTHREQ_PROMPTING`, then the create.)
- **21:37** — the production app accesses the microphone, macOS logs
  `Failed to match existing code requirement` and re-prompts
  (`AUTHREQ_PROMPTING`) — because the stored csreq is now the dev build's cdhash,
  not the production Developer ID requirement.
- **21:37:50** — `kTCCServiceAudioCapture` for the production app is *silently*
  granted (`authValue = 2`, no prompt), because that row is **path-keyed** and
  the dev build lives at a different path, so it was never overwritten.

That asymmetry (mic re-prompts, Audio Capture doesn't) is the fingerprint of
this specific bug.

### The fix

`build.sh` and `dev.sh` now re-sign the debug bundle with our Developer ID
(`sign_debug_bundle`) after staging the binary + sidecar and before launch, using
`src-tauri/entitlements.plist` (the dev entitlements, which keep
`get-task-allow` so debugging still works). No `--options runtime` (the hardened
runtime blocks `get-task-allow`), no `--deep` (we sign inner-to-outer by hand),
`--timestamp=none` (no notary needed locally). The debug build's main executable
then carries the **same** `ai.dial8.desktop` Developer ID DR as production, so
the two share the microphone grant instead of poisoning it.

If the Developer ID is missing from the keychain, the scripts print a loud
warning and continue ad-hoc (dev must not hard-fail) — but that build **will**
poison production until you install the cert.

#### Unbundled `cargo tauri dev` is safe

If you ever run a bare, unbundled binary (e.g. `cargo tauri dev` directly),
don't try to bolt signing into cargo's rebuild loop. An unbundled binary is
**path-keyed** in TCC (like Audio Capture), so it can't overwrite the shared
bundle-ID microphone row and doesn't poison production. Only the *bundled* debug
`.app` (which declares `ai.dial8.desktop`) is dangerous.

## The dev auto-update poisoning (Aug 2026)

Even with `sign_debug_bundle` in place, dev builds kept recording **silence**
while the in-app permission check said "granted" and no prompt ever appeared.
Root cause (confirmed via unified-log forensics, Aug 12 2026):

1. The updater plugin was registered unconditionally and the frontend
   auto-checks ~5s after launch (`app-updater.tsx`,
   `setTimeout(runScheduledCheck, 5000)` → `downloadAndInstall()`). The local
   `tauri.conf.json` version (0.2.39) trailed the released 0.2.40, so **every
   dev launch silently replaced the debug bundle on disk with the notarized
   production app** seconds after starting (bundle dir mtime 19:04:53 vs
   binary build 19:04:42; CDHash identical to `/Applications/Native Intelligence.app`).
2. tccd validates the **on-disk** bundle when coreaudiod asks about the mic.
   After the swap it logged `SecStaticCodeCreateWithPath ... -67011` and
   `Failed to match existing code requirement for subject ai.dial8.desktop and
   service kTCCServiceMicrophone`, then **denied silently** (`authValue=0`,
   deny reasons never prompt).
3. A TCC-denied mic still "works" at the API level: cpal's
   `build_input_stream` + `play()` return Ok and CoreAudio delivers
   **zero-filled buffers**, which satisfy the first-frame watchdog and stall
   detector (`mic_capture.rs`). The WAV fills with zeros; nothing errors.
4. The app's only permission probe (`request_screen_capture_permission` →
   `tap_helper_probe_permission()`) was aimed at `kTCCServiceAudioCapture` —
   **the wrong service** for a dead mic — and reported "granted". It could not
   have reported a denial even for its own service: tap creation succeeds even
   when Audio Capture is denied, so that probe never verified any permission
   (see "System audio permission is checked with
   TCCAccessPreflight/TCCAccessRequest" below).
   There was no mic-TCC check in the app at the time (`check_mic_permission` /
   `request_mic_permission` have since been added).
5. Revoke + re-grant in System Settings rewrites the row against whatever is
   on disk at that moment, so it "fixes" the session — until the next dev
   spin-up churns the bundle identity again.

Side effect worth knowing: after the swap, the *next* launch from
`target/debug/bundle/macos/` is the production binary, whose baked
`frontendDist` is `https://nativeintelligence.dev` — a "dev" session silently running
production against the production site.

**The fix:** the updater plugin is registered only under
`#[cfg(not(debug_assertions))]` in `src-tauri/src/lib.rs`. The frontend
tolerates the missing plugin (`checkForUpdate()` rejects; `app-updater.tsx`
catches and treats it as "no update"). Diagnostic gap still open: a real mic
permission surface (`AVCaptureDevice.authorizationStatus`) and a
pure-zeros-stream watchdog would make this failure visible instead of silent.

## System audio permission is checked with TCCAccessPreflight/TCCAccessRequest

Core Audio process taps are gated by the TCC service `kTCCServiceAudioCapture`
(System Settings → Privacy & Security → Screen & System Audio Recording).
Three facts, verified on macOS 27.0 in Sep 2026, decide how the app checks it:

1. **Tap creation cannot detect a denial.** macOS enforces the permission only
   when IO starts on the tap-backed aggregate device (the sidecar's
   `AudioDeviceStart`). `AudioHardwareCreateProcessTap` returns `noErr` and a
   valid tap even when the permission is denied or was never granted, and a
   denied capture just delivers zero-filled buffers. So the old
   `tap_helper_probe_permission()` (create a tap, destroy it) can never see a
   denial: on Sep 22 2026 it returned "granted" two minutes after the user had
   deleted the grant in System Settings (unified log + app log). It is no
   longer the source of truth; it survives only as the legacy command's
   fallback (table below).
2. **The only status/request API is the private TCC framework**, loaded at
   runtime with
   `dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC")`
   + `dlsym` (no link-time dependency, so a macOS without the symbols degrades
   to "unavailable" instead of failing to launch):
   - `int TCCAccessPreflight(CFStringRef service, CFDictionaryRef options)`
     returns **0 = granted, 1 = denied, 2 = not determined** (confirmed against
     tccd's own `AUTHREQ_RESULT` lines). It never prompts.
   - `void TCCAccessRequest(CFStringRef service, CFDictionaryRef options, void (^callback)(BOOL granted))`
     shows the real OS prompt while not determined (it needs
     `NSAudioCaptureUsageDescription`, present in `src-tauri/Info.plist`) and
     calls back `granted=false` immediately once denied — macOS never
     re-prompts.

   This is exactly what insidegui/AudioCap does. Private API use is acceptable
   because Native Intelligence ships Developer ID + notarized, not through the App Store.
3. **The Settings deep link is `Privacy_AudioCapture`:**
   `x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture`
   (anchor verified present in `SecurityPrivacyExtension.appex`; it opens the
   Screen & System Audio Recording pane, search title "Allow applications to
   record your system audio"). The microphone keeps `Privacy_Microphone`.

How the code is layered:

| Where | What it owns |
| --- | --- |
| `src-tauri/src/native/tcc_helper.m` | dlopen/dlsym once. `audio_capture_permission_status()` maps preflight 0/1/2 to **1 granted / 0 denied / 2 not determined**; `audio_capture_permission_request()` blocks on the prompt (semaphore, 120 s) and returns 1 / 0 / **-2 timed out**. **-1** from either = private API unavailable. |
| `src-tauri/src/permissions.rs` | The ONLY Rust code that reads those codes (unit-tested). `system_audio_permission()` (`unsupported` below macOS 14.4, where there are no taps) and both Settings deep links. |
| `check_system_audio_permission` | Passive status for the frontend — `granted` / `denied` / `not-determined` / `unavailable` / `unsupported` / `not_applicable`. One preflight, so it is cheap enough to poll every 1.5 s. |
| `request_system_audio_permission` | Not determined → the real prompt. Denied (or private API missing) → opens the Settings pane. Returns `granted` / `denied` / `opened-settings` / `unsupported` / `not_applicable`. |
| `request_screen_capture_permission` | LEGACY name that older web bundles call: the same flow in the old vocabulary (`granted` / `denied` / `unavailable`). Falls back to the old tap probe only when the private API is missing. |
| `start_macos` in `src-tauri/src/audio/system_capture.rs` | A **denied** status fails the system stream before any tap is created, which surfaces as `SystemAudioStatus::PermissionDenied` (the "Grant permission" warning) instead of a silent all-zeros system track. Not determined / unavailable proceed as before. |

## Microphone stream lifecycle

`MicCapture` keeps one cpal input stream alive across recordings — `stop()`
pauses it and the next `start()` replays it — because cycling CoreAudio input
units makes the mic sluggish. But a replayed stream can come back dead: in prod
(0.2.41) 6/6 reuses after ≥25 min idle produced no frames at all although
`play()` returned Ok, and overnight (lid closed, app left open) is the same
failure plus a sleep. So `start()` reuses a paused stream only when it is
provably safe (`reuse_verdict` in `src-tauri/src/audio/mic_capture.rs`), and
reopens instead when:

- the system slept since the stream was opened — a sleep/wake epoch bumped from
  NSWorkspace notifications (`src-tauri/src/power.rs`,
  `src-tauri/src/native/power_helper.m`);
- a different device is requested, or, for a default-device request, the
  system default input is no longer the device the stream opened (cpal binds a
  concrete device);
- the replayed stream fails `play()` or delivers no first frame within 2.5 s
  (a Bluetooth headset can take 1–2 s to switch profiles before its first
  frame, so a shorter wait would reopen healthy streams).

A replaced stream is retired and disposed off-thread: tearing it down (or
re-querying its dead device) used to hold the mic mutex for 8–21 s. Its
callbacks are made inert the moment it is retired, because a "dead" unit can
revive and would otherwise feed the replacement's WAV/PCM/level state. It is
also paused explicitly before the drop: cpal 0.15.3 keeps a stream on an
enumerated (non-default) device alive through a reference cycle in its
disconnect listener, so dropping it alone never stops the unit.

Mid-recording, a device can also die with no cpal error callback at all (a
Bluetooth headset switched away: one 2-hour capture logged "mic PCM stalled"
for 77 minutes and nothing recovered it). The session's stall watchdog flags
the same mic fault as the other detectors once the mic has delivered no data
callback for 10 s after its first frame, which drives the existing
`audio://mic-fault` → `recover_mic` path. Callbacks keep firing while a
recording is paused (pause only gates emission), so this is a pure
device-liveness signal with no pause hole. During a recording
`[Session] mic rms=… frame_age=…ms` is logged every 5 s, mirroring the
system-audio `rms=` line.

## The pre-Apr-20-2026 broken-updater-artifact era

Separately from dev builds, there was a window where **auto-updates** re-prompted
because the updater artifact was stale. `cargo tauri build` produces
`Native Intelligence.app.tar.gz` *before* `release.sh` re-signs with entitlements, injects the
Info.plist privacy keys, and notarizes — so the shipped updater delivered a
pre-re-signed app whose signature didn't match the installed one.

Commit **`d6b7e06` (Apr 20 2026)** fixed this: `release.sh` now rebuilds the
updater `tar.gz` from the **final** signed + notarized + stapled app (see the
"Rebuild updater bundle from the final signed app" step). Because the production
DR is stable across versions, updater-driven updates should not re-prompt. Don't
regress that ordering.

## What MUST stay stable for grants to persist

1. **Bundle identifier** — `ai.dial8.desktop`. Changing it orphans every existing
   microphone grant.
2. **Developer ID / team** — the certificate named by `NI_SIGNING_IDENTITY` in
   `.env.release` (`scripts/signing.sh`); its team ID is read from its name. A
   different signing identity produces a different DR and re-prompts everyone.
3. **The designated requirement** — must stay the team-OU Developer ID form, not
   an ad-hoc cdhash. This is what `release.sh`'s post-sign assertions guard.
4. **The bundle must not be modified after signing** — patching any file inside
   `Native Intelligence.app` after the final `codesign` invalidates the signature (and the
   notarization staple).

`release.sh` now fails the build if, on the freshly-signed app: the main exec
Identifier isn't `ai.dial8.desktop`, its TeamIdentifier isn't the signing team, its
DR doesn't reference `identifier "ai.dial8.desktop"` and that team, it lacks
`com.apple.security.device.audio-input`, or the sidecar's TeamIdentifier isn't
that team.

## Sidecar identifiers

`release.sh` signs every sidecar (`scripts/sidecars.sh`: `system-audio-capture`,
`dial8-local-stt`, and their dylibs in `Contents/Frameworks`) with the Developer
ID, hardened runtime and the production entitlements, then the
`codesign --force --deep` pass re-signs them with an Identifier equal to the
executable name — which is what ships. Sidecars never call a TCC-gated API (the
main process owns the mic, the process tap and every prompt), so their
identifiers are irrelevant to permissions; the post-sign assertions only check
that each one carries our TeamIdentifier.

History: `system-audio-capture` used to get `--identifier "ai.dial8.desktop"` on
its first signing pass (an old attempt to "share" TCC with the main app). The
`--deep` pass always overwrote it, so dropping the flag (2026-09, when sidecar
signing moved into `scripts/sidecars.sh`) leaves the shipped signature the same
— but the first release after that change must still go through the full
sign → notarize → staple pipeline and be checked on a clean machine before it
ships.

## How to debug TCC

- **Watch the decision live.** Bare `log` is a zsh builtin — use the full path:

  ```sh
  /usr/bin/log stream --predicate 'subsystem == "com.apple.TCC"' --info
  ```

  Reproduce the prompt (record audio) and watch for `AUTHREQ_PROMPTING`,
  `Create` rows, and `Failed to match existing code requirement`.

- **Look back at history** for a specific window:

  ```sh
  /usr/bin/log show --last 6h --predicate 'subsystem == "com.apple.TCC"' --info
  ```

- **Inspect what's actually granted.** Reading `TCC.db` directly needs Full Disk
  Access for your terminal:

  ```sh
  sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
    "SELECT service, client, client_type, auth_value FROM access WHERE client LIKE '%dial8%';"
  ```

  `client_type` 0 = bundle ID (microphone), 1 = path (Audio Capture).

- **Inspect a binary's signature / DR / entitlements:**

  ```sh
  codesign -dvvv "/Applications/Native Intelligence.app/Contents/MacOS/dial8-desktop"
  codesign -d -r- "/Applications/Native Intelligence.app/Contents/MacOS/dial8-desktop"
  codesign -d --entitlements - "/Applications/Native Intelligence.app/Contents/MacOS/dial8-desktop"
  ```

  A healthy production main executable shows `Identifier=ai.dial8.desktop`,
  `TeamIdentifier=<TEAM_ID>`, and the team-OU designated requirement. A poisoned
  or ad-hoc build shows `Signature=adhoc`, `TeamIdentifier=not set`, and a
  `cdhash` DR.

## The explicit don'ts

- **Never ship an ad-hoc build**, and never let a dev build record with an ad-hoc
  signature — it poisons the production microphone grant.
- **Never change the bundle identifier** (`ai.dial8.desktop`).
- **Never patch the bundle after signing** — it invalidates the signature and the
  notarization staple.
- **Don't "fix" the harmless sidecar identifier** without re-testing the full
  notarization pipeline end-to-end.
- **Don't change what permissions are requested** — microphone and Audio Capture
  only; never screen recording.
