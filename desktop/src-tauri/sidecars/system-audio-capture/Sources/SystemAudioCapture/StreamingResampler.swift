/// Sample-exact streaming sample-rate conversion for the capture paths.
///
/// Every capture mode hands one IOProc buffer at a time to a single, persistent
/// AVAudioConverter. The converter keeps its filter state and any input it has
/// not used yet between calls, so it must be fed as a stream:
///
///   - the input block hands over the pending buffer exactly once, then says
///     `.noDataNow`, so the converter never re-reads a buffer or pulls a
///     buffer it will not finish;
///   - the output buffer is big enough for everything this input can produce
///     (ceil(frames × ratio) plus the converter's priming/latency frames), and
///     `convert` is called again while it reports `.haveData` (output full), so
///     anything the converter still holds is drained;
///   - each call ends only on `.inputRanDry`, i.e. once the converter has used
///     all of the buffer and asked for more.
///
/// That way every input frame is converted exactly once and, over time, the
/// output length is input × out_rate / in_rate, short only by the converter's
/// fixed look-ahead (which `flush` releases at the end of the stream).
///
/// The previous code called `convert` once per IOProc with a floor(frames × ratio)
/// output and an input block that always answered `.haveData` with the same
/// buffer. With 512-frame buffers at 48 kHz, 2 input frames were left over per
/// call; after 256 calls the converter's leftover reached a whole buffer, the
/// next call was satisfied from it without asking for input, and that IOProc's
/// buffer was never converted: 10.7 ms lost every ~2.7 s (3906 ppm).
///
/// Not thread-safe: call it from one serial queue (the capture's processing
/// queue), never from the IOProc.

import AVFoundation

final class StreamingResampler {
    let inputFormat: AVAudioFormat
    let outputFormat: AVAudioFormat

    private let converter: AVAudioConverter
    /// out_rate / in_rate.
    private let ratio: Double
    /// Headroom for the output frames the converter holds back as look-ahead
    /// (6 at 48 kHz and 44.1 kHz → 16 kHz; primeInfo reports 0 for these
    /// formats, so a fixed floor covers it). It only sizes the output buffer:
    /// if it were ever short, the drain loop would still collect the rest.
    private static let lookAheadHeadroom: AVAudioFrameCount = 32
    private let latencyOutputFrames: AVAudioFrameCount
    /// Reused output buffer, grown when an input buffer needs more room.
    private var outputBuffer: AVAudioPCMBuffer?
    /// Output of one `process` call, collected so it is emitted (written) once.
    private var scratch: [Float] = []
    private var loggedError = false
    /// Test hook: caps the output buffer so the drain loop has to go round
    /// several times per input buffer. nil (the default) in the sidecar.
    private let maxOutputFramesPerConvert: AVAudioFrameCount?

    init?(
        from inputFormat: AVAudioFormat,
        to outputFormat: AVAudioFormat,
        maxOutputFramesPerConvert: AVAudioFrameCount? = nil
    ) {
        guard outputFormat.commonFormat == .pcmFormatFloat32,
              inputFormat.sampleRate > 0,
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            return nil
        }
        self.inputFormat = inputFormat
        self.outputFormat = outputFormat
        self.converter = converter
        self.ratio = outputFormat.sampleRate / inputFormat.sampleRate
        self.maxOutputFramesPerConvert = maxOutputFramesPerConvert.map { max($0, 1) }
        let prime = converter.primeInfo
        let primeInputFrames = Double(prime.leadingFrames) + Double(prime.trailingFrames)
        self.latencyOutputFrames = AVAudioFrameCount((primeInputFrames * ratio).rounded(.up))
            + StreamingResampler.lookAheadHeadroom
        scratch.reserveCapacity(4096)
    }

    /// Output frames one input buffer of `frames` frames can produce at most.
    func outputCapacity(forInputFrames frames: AVAudioFrameCount) -> AVAudioFrameCount {
        let capacity = AVAudioFrameCount((Double(frames) * ratio).rounded(.up)) + latencyOutputFrames
        return min(capacity, maxOutputFramesPerConvert ?? capacity)
    }

    /// Converts one input buffer. `emit` is called at most once, with all the
    /// output (channel 0) this input produced; it is not called when the
    /// converter produced nothing (e.g. while it primes). Returns false when
    /// the converter failed; it has then been reset.
    @discardableResult
    func process(_ input: AVAudioPCMBuffer, emit: (UnsafeBufferPointer<Float>) -> Void) -> Bool {
        guard input.frameLength > 0 else { return true }
        var handedOver = false
        let ok = drain(capacity: outputCapacity(forInputFrames: input.frameLength)) { _, status in
            if handedOver {
                status.pointee = .noDataNow
                return nil
            }
            handedOver = true
            status.pointee = .haveData
            return input
        }
        emitScratch(emit)
        return ok
    }

    /// Ends the stream: releases the frames the converter holds back as
    /// look-ahead, then resets it so it can start a new stream.
    func flush(emit: (UnsafeBufferPointer<Float>) -> Void) {
        _ = drain(capacity: min(latencyOutputFrames + 1024, maxOutputFramesPerConvert ?? .max)) { _, status in
            status.pointee = .endOfStream
            return nil
        }
        emitScratch(emit)
        converter.reset()
    }

    // MARK: - Private

    /// Calls `convert` until the converter runs dry (or ends), appending all
    /// output to `scratch`.
    private func drain(
        capacity: AVAudioFrameCount,
        input: @escaping AVAudioConverterInputBlock
    ) -> Bool {
        scratch.removeAll(keepingCapacity: true)
        let out: AVAudioPCMBuffer
        if let existing = outputBuffer, existing.frameCapacity >= capacity {
            out = existing
        } else {
            guard let fresh = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
                return false
            }
            outputBuffer = fresh
            out = fresh
        }

        while true {
            out.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: out, error: &error, withInputFrom: input)
            if status == .error || error != nil {
                if !loggedError {
                    loggedError = true
                    fputs("[StreamingResampler] convert failed: \(error?.localizedDescription ?? "unknown error"); resetting\n", stderr)
                }
                scratch.removeAll(keepingCapacity: true)
                converter.reset()
                return false
            }
            let produced = Int(out.frameLength)
            if produced > 0, let data = out.floatChannelData {
                scratch.append(contentsOf: UnsafeBufferPointer(start: data[0], count: produced))
            }
            // .haveData: the output buffer filled up and the converter may hold
            // more, so go round again. .inputRanDry / .endOfStream: done.
            if status != .haveData || produced == 0 {
                return true
            }
        }
    }

    private func emitScratch(_ emit: (UnsafeBufferPointer<Float>) -> Void) {
        guard !scratch.isEmpty else { return }
        scratch.withUnsafeBufferPointer { emit($0) }
    }
}
