#!/bin/bash
# Offline check of the capture paths' sample-rate conversion
# (Sources/SystemAudioCapture/StreamingResampler.swift). Opens no audio
# device: it feeds synthetic IOProc-sized buffers and compares the output
# with the analytic signal and a reference resample.
# $1 = simulated minutes per case (default 10).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR=".build/resampler-check"
mkdir -p "$OUT_DIR"
swiftc -O -swift-version 5 \
    -o "$OUT_DIR/resampler-check" \
    Sources/SystemAudioCapture/StreamingResampler.swift \
    harness/resampler-check/main.swift
"$OUT_DIR/resampler-check" "${1:-10}"
