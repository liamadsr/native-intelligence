// Offline check for StreamingResampler (the capture paths' sample-rate
// conversion). No audio device is opened: synthetic IOProc-sized buffers of a
// continuous sine go through the exact code the sidecar ships, and the output
// is checked for:
//
//   1. frame counts: at every call the output is behind input × ratio by no
//      more than the converter's fixed look-ahead, and after the final flush
//      it equals the reference length exactly;
//   2. no gaps: the output tracks the analytic sine sample by sample (any lost
//      or repeated input shows up as a phase jump), and its second difference
//      never spikes past the sine's own bound;
//   3. the output matches a reference resample (the same converter
//      configuration pulling the whole signal in one stream).
//
// It also runs the pre-fix per-IOProc logic on the same input and prints its
// numbers, for the before/after comparison. Those are reported, not asserted.
//
// Run: harness/run-resampler-check.sh [minutes]   (default 10 simulated minutes per case)

import AVFoundation
import Foundation

// MARK: - Signal

let toneHz = 997.0
let toneAmp = 0.5

/// Stereo interleaved float32, the aggregate device's tap format.
func tapFormat(rate: Double) -> AVAudioFormat {
    var asbd = AudioStreamBasicDescription(
        mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8,
        mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
    return AVAudioFormat(streamDescription: &asbd)!
}

let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

func sample(_ n: Int, rate: Double) -> Float {
    // Phase from an exact rational so minutes of signal keep full precision.
    let cycles = Double(n) * toneHz / rate
    let frac = cycles - cycles.rounded(.down)
    return Float(toneAmp * sin(2 * Double.pi * frac))
}

/// Fills `buf` (stereo interleaved) with frames [start, start + count).
func fill(_ buf: AVAudioPCMBuffer, start: Int, count: Int, rate: Double) {
    buf.frameLength = AVAudioFrameCount(count)
    let p = buf.floatChannelData![0]
    for i in 0..<count {
        let v = sample(start + i, rate: rate)
        p[2 * i] = v
        p[2 * i + 1] = v
    }
}

// MARK: - Chunk patterns

struct LCG {
    var s: UInt64
    mutating func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s >> 33 }
}

enum Pattern: CustomStringConvertible {
    case fixed(Int)
    case irregular(seed: UInt64)
    var description: String {
        switch self {
        case .fixed(let n): return "\(n)"
        case .irregular: return "irregular"
        }
    }
    func sizes() -> AnyIterator<Int> {
        switch self {
        case .fixed(let n): return AnyIterator { n }
        case .irregular(let seed):
            var rng = LCG(s: seed)
            let menu = [1, 2, 3, 7, 64, 127, 256, 441, 480, 511, 512, 513, 1000, 1024, 2048, 4096]
            return AnyIterator {
                let r = rng.next()
                return r % 3 == 0 ? Int(1 + (r / 3) % 4096) : menu[Int((r / 3) % UInt64(menu.count))]
            }
        }
    }
}

// MARK: - Drivers

struct StreamResult {
    var out: [Float] = []
    var inFrames = 0
    var minDeficit = Int.max
    var maxDeficit = Int.min
    var endDeficit = 0          // before the flush
    var minWrite = Int.max       // after warm-up, fixed patterns
    var maxWrite = 0
    var writesBelowLegacy = 0    // writes smaller than today's floor(chunk × ratio)
    var inputBlockCalls = 0
}

/// The fixed code: StreamingResampler, exactly as the sidecar uses it.
func runFixed(rate: Double, pattern: Pattern, totalFrames: Int, chunkLimit: AVAudioFrameCount?) -> StreamResult {
    let fmt = tapFormat(rate: rate)
    let rs = StreamingResampler(from: fmt, to: outFormat, maxOutputFramesPerConvert: chunkLimit)!
    let ratio = outFormat.sampleRate / rate
    var r = StreamResult()
    r.out.reserveCapacity(Int(Double(totalFrames) * ratio) + 4096)
    let it = pattern.sizes()
    var calls = 0
    while r.inFrames < totalFrames {
        let n = min(it.next()!, totalFrames - r.inFrames)
        let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n))!
        fill(buf, start: r.inFrames, count: n, rate: rate)
        r.inFrames += n
        var wrote = 0
        var emits = 0
        let ok = rs.process(buf) { samples in
            emits += 1
            wrote = samples.count
            r.out.append(contentsOf: samples)
        }
        precondition(ok, "convert failed")
        precondition(emits <= 1, "one input buffer produced \(emits) writes")
        calls += 1
        let deficit = Int((Double(r.inFrames) * ratio).rounded(.down)) - r.out.count
        r.minDeficit = min(r.minDeficit, deficit)
        r.maxDeficit = max(r.maxDeficit, deficit)
        if case .fixed = pattern, calls > 8, r.inFrames < totalFrames {
            r.minWrite = min(r.minWrite, wrote)
            r.maxWrite = max(r.maxWrite, wrote)
            if wrote < Int((Double(n) * ratio).rounded(.down)) { r.writesBelowLegacy += 1 }
        }
    }
    r.endDeficit = Int((Double(r.inFrames) * ratio).rounded(.down)) - r.out.count
    rs.flush { r.out.append(contentsOf: $0) }
    return r
}

/// The pre-fix logic, copied from TapAudioCapture.processAudioBuffer.
func runLegacy(rate: Double, pattern: Pattern, totalFrames: Int) -> StreamResult {
    let fmt = tapFormat(rate: rate)
    let conv = AVAudioConverter(from: fmt, to: outFormat)!
    let ratio = outFormat.sampleRate / rate
    var r = StreamResult()
    r.out.reserveCapacity(Int(Double(totalFrames) * ratio) + 4096)
    let it = pattern.sizes()
    while r.inFrames < totalFrames {
        let n = min(it.next()!, totalFrames - r.inFrames)
        let inputBuffer = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n))!
        fill(inputBuffer, start: r.inFrames, count: n, rate: rate)
        r.inFrames += n
        let cap = AVAudioFrameCount(Double(n) * outFormat.sampleRate / fmt.sampleRate)
        guard cap > 0, let ob = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { continue }
        var error: NSError?
        conv.convert(to: ob, error: &error) { _, st in
            r.inputBlockCalls += 1
            st.pointee = .haveData
            return inputBuffer
        }
        guard error == nil, ob.frameLength > 0 else { continue }
        r.out.append(contentsOf: UnsafeBufferPointer(start: ob.floatChannelData![0], count: Int(ob.frameLength)))
    }
    r.endDeficit = Int((Double(r.inFrames) * ratio).rounded(.down)) - r.out.count
    return r
}

/// Reference: a fresh converter pulling the whole signal as one stream, in
/// 64k-frame slices, then end of stream. This is AVAudioConverter's own
/// pull model with nothing for a driver to get wrong.
func runReference(rate: Double, totalFrames: Int) -> [Float] {
    let fmt = tapFormat(rate: rate)
    let conv = AVAudioConverter(from: fmt, to: outFormat)!
    let slice = 65536
    let inBuf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(slice))!
    var pos = 0
    var out: [Float] = []
    let cap = AVAudioFrameCount(1 << 20)
    let ob = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap)!
    while true {
        ob.frameLength = 0
        var error: NSError?
        let st = conv.convert(to: ob, error: &error) { _, s in
            if pos >= totalFrames { s.pointee = .endOfStream; return nil }
            let n = min(slice, totalFrames - pos)
            fill(inBuf, start: pos, count: n, rate: rate)
            pos += n
            s.pointee = .haveData
            return inBuf
        }
        precondition(error == nil && st != .error, "reference convert failed")
        out.append(contentsOf: UnsafeBufferPointer(start: ob.floatChannelData![0], count: Int(ob.frameLength)))
        if st == .endOfStream { break }
    }
    return out
}

// MARK: - Measurements

struct Continuity {
    var amp = 0.0
    var maxResidual = 0.0       // |out - fitted sine|, edges excluded
    var firstBad = -1           // first output index with residual > threshold
    var badSamples = 0
    var maxD2Ratio = 0.0        // max |second difference| / (amp × ω²)
}

/// Fits a·sin + b·cos at the tone frequency on the first second of output
/// (the SRC's fixed delay and gain), then measures the whole run against it.
func continuity(_ y: [Float], threshold: Double) -> Continuity {
    let fs = outFormat.sampleRate
    let w = 2 * Double.pi * toneHz / fs
    let fitFrom = Int(0.1 * fs), fitTo = min(y.count, Int(1.1 * fs))
    var ss = 0.0, cc = 0.0, sc = 0.0, ys = 0.0, yc = 0.0
    for n in fitFrom..<fitTo {
        let s = sin(w * Double(n)), c = cos(w * Double(n))
        ss += s * s; cc += c * c; sc += s * c
        ys += Double(y[n]) * s; yc += Double(y[n]) * c
    }
    let det = ss * cc - sc * sc
    let a = (ys * cc - yc * sc) / det
    let b = (yc * ss - ys * sc) / det
    var r = Continuity()
    r.amp = (a * a + b * b).squareRoot()
    let edge = Int(0.05 * fs)
    let bound = r.amp * w * w
    // Recompute sin/cos from the index with a reduced phase for precision.
    let cyclesPerSample = toneHz / fs
    for n in edge..<(y.count - edge) {
        let cyc = Double(n) * cyclesPerSample
        let ph = 2 * Double.pi * (cyc - cyc.rounded(.down))
        let e = abs(Double(y[n]) - (a * sin(ph) + b * cos(ph)))
        if e > r.maxResidual { r.maxResidual = e }
        if e > threshold {
            r.badSamples += 1
            if r.firstBad < 0 { r.firstBad = n }
        }
        if n >= 2 {
            let d2 = abs(Double(y[n]) - 2 * Double(y[n - 1]) + Double(y[n - 2]))
            r.maxD2Ratio = max(r.maxD2Ratio, d2 / bound)
        }
    }
    return r
}

func maxAbsDiff(_ x: [Float], _ y: [Float]) -> (Double, Int) {
    let n = min(x.count, y.count)
    var m = 0.0, mismatched = 0
    for i in 0..<n {
        let d = abs(Double(x[i]) - Double(y[i]))
        if d > m { m = d }
        if d != 0 { mismatched += 1 }
    }
    return (m, mismatched)
}

// MARK: - Main

let minutes = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1])! : 10
let residualThreshold = 1e-3     // −54 dB re the 0.5 tone; one lost sample of 997 Hz at 16 kHz is ~0.19
let referenceTolerance = 1e-6

// The third field caps the converter's output buffer (test hook) so the drain
// loop runs several convert calls per input buffer; nil is the sidecar's setting.
let cases: [(Double, Pattern, AVAudioFrameCount?)] = [
    (48000, .fixed(512), nil), (48000, .fixed(1024), nil), (48000, .fixed(480), nil), (48000, .fixed(441), nil),
    (48000, .irregular(seed: 1), nil),
    (44100, .fixed(512), nil), (44100, .fixed(1024), nil), (44100, .fixed(480), nil), (44100, .fixed(441), nil),
    (44100, .irregular(seed: 2), nil),
    (48000, .fixed(512), 7), (44100, .irregular(seed: 3), 7),
]

/// The converter's fixed look-ahead, in output frames: it holds back 6 frames
/// at these rates (primeInfo reports 0), so the running deficit
/// floor(in × ratio) − out must stay within [0, 8] for the whole run. Any drift
/// (lost or duplicated input) would push it out: 1 ppm over 10 minutes is ~10
/// frames.
let lookaheadOut = 8

print(String(format: "resampler-check: %.1f simulated minutes per case, %.0f Hz tone", minutes, toneHz))
var failures: [String] = []

for (rate, pattern, chunkLimit) in cases {
    let total = Int(minutes * 60 * rate)
    let ratio = outFormat.sampleRate / rate
    let ideal = Double(total) * ratio
    let label = "\(Int(rate)) Hz / \(pattern)" + (chunkLimit.map { ", output capped at \($0) frames per convert" } ?? "")

    let ref = runReference(rate: rate, totalFrames: total)
    let fixed = runFixed(rate: rate, pattern: pattern, totalFrames: total, chunkLimit: chunkLimit)
    let legacy = runLegacy(rate: rate, pattern: pattern, totalFrames: total)

    let prime = AVAudioConverter(from: tapFormat(rate: rate), to: outFormat)!.primeInfo

    let (refDiff, refMismatch) = maxAbsDiff(fixed.out, ref)
    let cFixed = continuity(fixed.out, threshold: residualThreshold)
    let cLegacy = continuity(legacy.out, threshold: residualThreshold)
    let cRef = continuity(ref, threshold: residualThreshold)

    let legacyPpm = (Double(legacy.out.count) / ideal - 1) * 1e6
    let fixedPpm = (Double(fixed.out.count) / ideal - 1) * 1e6

    print("")
    print("== \(label): \(total) input frames, ideal output \(String(format: "%.2f", ideal)), reference \(ref.count)")
    print(String(format: "  before: output %d (%+.1f ppm, %+.1f s/hour), end deficit %d, input-block calls %d",
                 legacy.out.count, legacyPpm, legacyPpm * 3600 / 1e6, legacy.endDeficit, legacy.inputBlockCalls))
    print(String(format: "          vs sine: max residual %.4f, %d bad samples (first at %.3f s), max d2/bound %.2f",
                 cLegacy.maxResidual, cLegacy.badSamples,
                 cLegacy.firstBad < 0 ? -1 : Double(cLegacy.firstBad) / 16000, cLegacy.maxD2Ratio))
    print(String(format: "  after:  output %d (%+.3f ppm), deficit during run %d…%d (look-ahead bound %d, primeInfo leading %d trailing %d), end deficit %d before flush",
                 fixed.out.count, fixedPpm, fixed.minDeficit, fixed.maxDeficit, lookaheadOut,
                 prime.leadingFrames, prime.trailingFrames, fixed.endDeficit))
    print(String(format: "          vs sine: max residual %.2e (reference's own %.2e), %d bad samples, max d2/bound %.3f; amp %.4f",
                 cFixed.maxResidual, cRef.maxResidual, cFixed.badSamples, cFixed.maxD2Ratio, cFixed.amp))
    print(String(format: "          vs reference: max |diff| %.2e, %d samples differ", refDiff, refMismatch))
    if case .fixed(let n) = pattern {
        print("          writes per IOProc: \(fixed.minWrite)…\(fixed.maxWrite) frames (before: \(Int((Double(n) * ratio).rounded(.down)))), \(fixed.writesBelowLegacy) below before's size")
    }

    func check(_ cond: Bool, _ msg: String) { if !cond { failures.append("\(label): \(msg)") } }
    check(fixed.out.count == ref.count, "length \(fixed.out.count) != reference \(ref.count)")
    check(abs(Double(ref.count) - ideal) <= 1, "reference length \(ref.count) not within 1 of ideal \(ideal)")
    // With the output capped, the converter hands back its look-ahead in
    // smaller steps, so the held-back amount swings wider (5…12 frames seen)
    // but must still stay bounded, never drift.
    let deficitBound = chunkLimit == nil ? lookaheadOut : 2 * lookaheadOut
    check(fixed.minDeficit >= 0 && fixed.maxDeficit <= deficitBound,
          "deficit \(fixed.minDeficit)…\(fixed.maxDeficit) outside [0, \(deficitBound)]")
    check(refDiff <= referenceTolerance, "differs from reference by \(refDiff)")
    check(cFixed.badSamples == 0, "\(cFixed.badSamples) samples off the sine (max \(cFixed.maxResidual))")
    check(cFixed.maxD2Ratio <= 1.05, "second-difference spike \(cFixed.maxD2Ratio)× the sine's bound")
    check(abs(cFixed.amp - toneAmp) < 0.01, "tone amplitude \(cFixed.amp), expected \(toneAmp)")
    if case .fixed = pattern, chunkLimit == nil {
        check(fixed.writesBelowLegacy == 0, "\(fixed.writesBelowLegacy) writes smaller than before")
    }
}

print("")
if failures.isEmpty {
    print("PASS: all \(cases.count) cases")
} else {
    print("FAIL:")
    failures.forEach { print("  - \($0)") }
    exit(1)
}
