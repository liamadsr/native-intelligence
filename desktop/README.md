# Native Intelligence Desktop (Tauri v2)

Cross-platform desktop app wrapping the Native Intelligence web app with native audio capture.

## Prerequisites

- [Rust](https://rustup.rs/) (1.87+)
- [Node.js](https://nodejs.org/) (20+)
- Tauri CLI: `cargo install tauri-cli --version "^2"`
- Xcode Command Line Tools (Swift, Metal)
- `brew install cmake ninja` — builds the local speech-to-text sidecar
- After cloning: `GIT_LFS_SKIP_SMUDGE=1 git submodule update --init` (the local-stt
  `build.sh` also does this on first build)

## Project Structure

```
dial8-desktop/
  scripts/
    sidecars.sh    # build / stage / sign every sidecar (used by dev.sh, build.sh, release.sh)
    licenses.sh    # stage third-party notices into the bundle (same callers)
    licenses/      # notice generators, standard license texts (spdx/), copyright holders (holders.tsv)
    modules/bump.sh  # move a sidecar's upstream submodule, rebuild, re-bench
  src-tauri/
    src/           # Rust backend (audio capture, IPC commands, deep-link handling)
      modules/     # local modules: sidecar supervisor, model downloads, local-stt
    sidecars/      # one folder per sidecar; each has build.sh → .out/bin, .out/lib, .out/licenses
      system-audio-capture/  # Swift: system audio tap, meeting detection, calendar
      local-stt/             # C++: on-device transcription (NVIDIA NeMo-Speech.cpp)
      studio-recorder/       # Swift: Studio takes (screen, window, camera, mic, input trace)
    Cargo.toml
    tauri.conf.json
    capabilities/  # Tauri permission config
    icons/         # App icons
```

Adding a sidecar = adding a folder under `src-tauri/sidecars/` with a `build.sh`;
the build/release scripts pick it up. Its `build.sh` must also write
`.out/licenses/NOTICES.txt` (plus the license texts it cites) — one with no
third-party code writes a NOTICES.txt saying so, as `system-audio-capture/build.sh`
does. Nothing writes it for a sidecar: release.sh stops on a staged sidecar without it.

Third-party notices: `licenses_stage` (scripts/licenses.sh) rebuilds `Contents/Resources/Licenses/`
on every dev.sh / build.sh dev / release.sh run, before signing, from three sources:

- the Rust crates statically linked into the main executable — exactly the set in Cargo's
  build graph for the release build (`cargo tree -e normal,no-proc-macro --features
  tauri/custom-protocol`, host target), with each crate's own license files
  (`scripts/licenses/rust_crates.py`; `cargo metadata` only for crate details);
- the Rust standard library it also links, from the toolchain's own `COPYRIGHT-library`
  and license texts (`scripts/licenses/rust_std.py`; needs the `rust-docs` rustup component);
- each staged sidecar's `.out/licenses/`,

folded into the self-contained `THIRD_PARTY_NOTICES.txt` that Help → Open Source Licenses
opens (from a copy in the app's cache folder). Nothing to refresh by hand. After a
dependency change, `python3 -B scripts/licenses/rust_crates.py /tmp/lic` exits 1 naming
any crate it can't cover (add its standard text to `scripts/licenses/spdx/`; if the
crate's authors aren't the holders of that text, add a row to `scripts/licenses/holders.tsv`).
`./build.sh prod` bundles have no sidecars and no notices: local testing only.

Local modules (a sidecar + downloadable models + an on/off setting) are described
in `web/docs/plans/local-modules.md`.

The webview loads the Native Intelligence web app — `localhost:3000` in dev, `https://nativeintelligence.dev` in production.

## Development

### Quick iteration (no deep-link testing)

```bash
# Terminal 1: Start the Next.js dev server
cd ../web && npm run dev

# Terminal 2: Start Tauri dev mode
cd dial8-desktop && cargo tauri dev
```

This runs the Rust backend + webview pointing at `localhost:3000`. Hot-reload works for the frontend. Rust changes trigger a recompile.

**Note:** Deep links (`dial8desktop://`) do NOT work in `cargo tauri dev` on macOS because there's no `.app` bundle to register the URL scheme with Launch Services.

### Testing deep links (auth flow)

Deep links require a bundled `.app` installed on the system:

```bash
# 1. Make sure frontendDist points to localhost for dev testing
#    In src-tauri/tauri.conf.json, set:
#    "frontendDist": "http://localhost:3000"

# 2. Build debug bundle
cd dial8-desktop && cargo tauri build --debug

# 3. Install to /Applications
rm -rf "/Applications/Native Intelligence.app"
cp -r "src-tauri/target/debug/bundle/macos/Native Intelligence.app" /Applications/

# 4. Start the Next.js dev server
cd ../web && npm run dev

# 5. Open the app
open "/Applications/Native Intelligence.app"
```

To see Rust-side logs (deep-link debug output), run from terminal:

```bash
"/Applications/Native Intelligence.app/Contents/MacOS/dial8-desktop"
```

To verify the URL scheme is registered:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep dial8desktop
```

## Production Build

```bash
# 1. Set frontendDist to production URL
#    In src-tauri/tauri.conf.json, set:
#    "frontendDist": "https://nativeintelligence.dev"

# 2. Build release
cd dial8-desktop && cargo tauri build

# 3. Output locations:
#    macOS .app:  src-tauri/target/release/bundle/macos/Native Intelligence.app
#    macOS .dmg:  src-tauri/target/release/bundle/dmg/Native Intelligence_<version>_aarch64.dmg
#    Windows:     src-tauri/target/release/bundle/nsis/Dial8_<version>_x64-setup.exe
```

## Windows

This Mac can't build for Windows, so GitHub does (`.github/workflows/windows.yml`, `windows-latest`):

Windows still installs under the product's earlier name, Dial8 (`src-tauri/tauri.windows.conf.json`
overrides `productName` for Windows only). The installer finds an earlier install by its product
name: under a new name it would install a second copy beside the old one, whose shortcuts would
keep opening the old version. The name changes on Windows once the installer removes that earlier
install first.

- **Every PR and push to main:** `cargo check` + `cargo test` on Windows, plus the browser-exit crate's tests.
- **A release:** `./release.sh --version X.Y.Z --notes "..."` runs it all on the Mac:
  - It dispatches the Windows build of the pushed commit first, so both build at once. The tree must
    be clean and HEAD pushed.
  - After the Mac build it downloads `Dial8_X.Y.Z_x64-setup.exe` and checks its SHA-256.
  - It signs the exe for the updater with the key in `src-tauri/keys/` (it never goes to GitHub).
  - It uploads it twice: `Dial8_X.Y.Z_x64-setup.exe` for the updater, and over `Dial8-setup.exe`, the
    website's download.
  - The `desktop_releases` row gets `windows-x86_64` beside `darwin-aarch64`.
  - If the Windows build fails, macOS is still published and Windows users stay on their version.
    `--skip-windows` releases macOS alone.
  - Windows goes out with a release only once its Authenticode signing is set up
    (`docs/WINDOWS_SIGNING.md`; release.sh checks the `ARTIFACT_SIGNING_ACCOUNT` repository variable).
    `--windows` sends it before that, unsigned.
- **A test build without releasing:** `gh workflow run windows.yml` (no version = tauri.conf.json's),
  then `gh run download` the `dial8-windows-x64` artifact.

The installer is NSIS, per-user (no admin prompt), x64. Release builds are Authenticode-signed with
Azure Artifact Signing once its repository variables are set (`docs/WINDOWS_SIGNING.md`); until then,
and for PR test builds, Windows shows SmartScreen's "Unknown publisher" (More info → Run anyway). Updates verify the minisign
signature and the installer's own VERSIONINFO, then wait for the person's "Restart now" to run it
(`src-tauri/src/app_update.rs`). The plan, and what works on Windows in each phase, is in
`web/docs/plans/windows-desktop.md`.

## Config Toggle: Dev vs Production

The only thing that changes between dev and prod is `frontendDist` in `src-tauri/tauri.conf.json`:

| Mode | `frontendDist` |
|------|---------------|
| Dev  | `http://localhost:3000` |
| Prod | `https://nativeintelligence.dev` |

`devUrl` is only used by `cargo tauri dev` and doesn't affect builds.

## Auth Flow (Desktop)

1. User clicks "Sign in with Google" in the Tauri webview
2. OAuth URL opens in the **system browser** (not the webview)
3. After Google auth, Supabase redirects to `/auth/desktop-callback?code=...`
4. The callback page redirects to `dial8desktop://auth/callback?code=...`
5. macOS opens the Tauri app via the registered URL scheme
6. Rust receives the deep-link event, forwards to the webview
7. The webview exchanges the code for a Supabase session client-side

### Supabase Setup

The following redirect URLs must be whitelisted in Supabase Dashboard → Authentication → URL Configuration → Redirect URLs:

- `http://localhost:3000/auth/desktop-callback` (dev)
- `https://nativeintelligence.dev/auth/desktop-callback` (prod)
- `https://dial8.ai/auth/desktop-callback` (prod, for builds that still load that address: keep it while that domain serves the app)

## Key Crates

| Crate | Purpose |
|-------|---------|
| `cpal` | Cross-platform microphone capture |
| `hound` | WAV file writing |
| `reqwest` | Cloud transcription API calls |
| `tauri-plugin-deep-link` | `dial8desktop://` URL scheme |
| `tauri-plugin-opener` | Open system browser for OAuth |
