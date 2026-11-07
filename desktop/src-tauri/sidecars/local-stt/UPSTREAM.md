# local-stt upstream

- **Upstream:** [NVIDIA/NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) — git submodule `upstream/`; the submodule commit is the pin.
- **Our surface:** the public C ABI only (`nemo_speech/asr.h`), linked through the installed CMake package (`find_package(NeMoSpeech COMPONENTS ASR)`). Upstream's `examples/transcribe_live.cpp` is the closest reference — when it changes in a bump, re-check `src/main.cpp`.
- **Models:** pinned in `module.json` (Hugging Face revision + sha256 + size); bump `assetsVersion` whenever an asset changes.
- **Build:** `./build.sh release` → `.out/bin/dial8-local-stt` + `.out/lib/*.dylib`. Needs `cmake ≥ 3.26` and `ninja` (Homebrew). SentencePiece is built from source as a static library at upstream's pinned commit, so nothing from Homebrew ships. CPU baseline is M1 (`armv8.2-a+dotprod+fp16`), min macOS 13.0.
- **Licenses:** `build.sh` also writes `.out/licenses/` — `NOTICES.txt` (every third-party component compiled into the binaries, with version, copyright and license) plus the full texts, copied from `upstream/`, `.out/sdk` and `.out/deps/sentencepiece-src`; a missing text fails the build. `licenses_stage` (`scripts/licenses.sh`) stages it into `Contents/Resources/Licenses/local-stt/` and folds it into `THIRD_PARTY_NOTICES.txt` (Help → Open Source Licenses). On a bump, recheck the component list in `build.sh` step 5 against the build graph.
- **Bump:** `scripts/modules/bump.sh local-stt <ref>` → rebuild + `bench/bench.sh`. Gates: speaker agreement ≥ 0.97 (interview, teams-call) / ≥ 0.85 (fast-talk); transcript difference vs Deepgram ≤ 0.07 / 0.07 / 0.18; exact speaker counts. Then `bench/finalize.py` on each file (the voice session's `finalize`: one `mic` stream, no diarizer, real time) must PASS: every finalize acked, no ordering violations.
- **`finalize` relies on upstream internals:** `nemo_speech_asr_stream_force_endpoint` publishes after all *decodable* audio, which excludes the lookahead (one chunk). `main.cpp` pads each finalize with two chunks of silence (upstream's own end-of-stream flush size) so the last words are decoded before the ack. Measured 2026-09-26 on interview (120 s, a mid-word finalize every ~7 s): without the pad only 59/80 of the words ending just before a finalize made it into the pre-ack final, the rest were lost outright, and the run produced 353 words instead of 396; with it, 76/80 (the misses are spelling differences vs Deepgram). If a bump changes the chunk geometry or `force_eou`, rerun `bench/finalize.py`.

## Patches

| Patch | Why | Upstream |
|---|---|---|
| `0001-c-api-interim-word-offsets.patch` | Appends `interim_word_offsets` to `nemo_speech_asr_recognition_options` so interim results carry word timings + speaker tags through the C ABI (upstream's CLI does this via the C++ API). The web replaces an interim with the final starting within 0.5 s of it, so interims need word start times. | to be proposed |

## Bump log

| Date | Upstream | interview | teams-call | fast-talk | Notes |
|---|---|---|---|---|---|
| 2026-09-25 | `97a15af` | 0.984 / 0.057 | 0.988 / 0.066 | 0.883 / 0.151 | Initial pin. Speaker agreement / transcript difference vs Deepgram, through the sidecar (0.56 s chunks). Speaker counts exact (4 / 6 / 2). 14–16× real time per stream on an M2 Max. |
