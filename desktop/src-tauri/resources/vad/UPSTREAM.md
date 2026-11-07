# Silero VAD model upstream

The chat-voice voice activity detector (`src/voice/silero.rs`, dial8-website
`docs/plans/chat-voice.md` §3.3a) embeds this model in the app executable with
`include_bytes!` and runs it on the ONNX Runtime the local-tts module ships.

- Model: Silero VAD v6.2.3, 16 kHz only, ONNX opset 15 (`silero_vad_16k_op15.onnx`)
- Upstream: https://github.com/snakers4/silero-vad
- Tag: `v6.2.3` = commit `5cd7945676eb32225748052e2e6a0580e4686a08`
- URL: https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad_16k_op15.onnx
- SHA-256: `7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49`
- Size (bytes): `1289603`
- Licence: MIT, Copyright (c) 2020-present Silero Team (`licenses/LICENSE-silero-vad.txt`, the repository's `LICENSE` at that tag)

`silero.rs`'s test `the_bundled_model_is_the_pinned_one` checks the SHA-256 and
size above against the embedded bytes, so a changed file without a changed
pin fails `cargo test`.

## Interface (what `silero.rs` relies on)

- Inputs: `input` f32 `[1, 576]` (64 samples of context from the previous call,
  then 512 new samples, 16 kHz mono in [-1, 1]); `state` f32 `[2, 1, 128]`;
  `sr` int64 scalar (16000).
- Outputs: `output` f32 `[1, 1]` (speech probability); `stateN` f32 `[2, 1, 128]`,
  fed back as `state` on the next call.

## Why this file

Picked by the S2 bake-off (2026-09-26; Silero v5.1.2, v6.2.3, v6.2.3 16k op15,
earshot and WebRTC VAD on `~/code/speech-audio-bench` with Deepgram word
timings): v6.2.3 16k op15 matched the full v6.2.3 model's frame F1 (0.937
pooled on the real recordings at 0.5) at half the size, and fired on none of
the non-speech clips (tones, hum, clicks, white/pink noise to -30 dBFS).
earshot 1.2.2 is the fallback when ONNX Runtime can't be loaded.

## Licence notices

`licenses/` is staged by `scripts/licenses.sh` as its own part of
Help → Open Source Licenses (`Licenses/vad/`), because the weights ship inside
the main executable; `release.sh` verifies it is there.

## Bump

Download the new release's `silero_vad_16k_op15.onnx` from its tag commit,
update the commit, URL, SHA-256 and size here, check the licence, and check the
interface above still holds (`cargo test --lib silero`, plus the ignored
`detects_speech_in_the_interview_bench` against the speech bench).
