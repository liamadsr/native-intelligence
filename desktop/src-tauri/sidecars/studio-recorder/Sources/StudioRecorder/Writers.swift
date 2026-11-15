import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers
import CryptoKit

/// Every file of a take is written as fragmented MP4, in segments of about
/// this long: the file on disk is the init segment followed by each finished
/// segment, so it can be read and uploaded as it grows, and a crash or a power
/// cut loses at most the segment being written. A picture's segment starts on
/// a key frame.
let segmentInterval = CMTime(value: 2, timescale: 1)

/// The track time scale of every picture: a whole number of ticks per frame at
/// 30 and 60 fps, so each frame's time is exact.
let videoTimeScale: CMTimeScale = 600

/// One segment as it went to disk: `offset` and `length` in the file, and the
/// end of the media it holds (seconds from the file's start; nil for the init).
struct SegmentRecord {
    let index: Int
    let kind: String
    let offset: Int64
    let length: Int
    let endSeconds: Double?
    var json: [String: Any] { ["index": index, "kind": kind, "offset": offset, "length": length, "endSeconds": jsonNumber(endSeconds)] }
}

/// Takes an AVAssetWriter's segments and appends each to the file, then its
/// line to `<file>.segments` (`init|media offset length [endSeconds]`). The
/// bytes go first and are on the disk (synced) before their line is written,
/// and the line is synced before anyone hears of the segment: after a power
/// cut, a segment the app announced is whole on disk. A crash between the two
/// writes leaves bytes the index does not count, which whoever reads the take
/// cuts back. The file's SHA-256 is kept as it is written (`sha256`, once
/// closed): the Studio refuses a copy whose bytes hash otherwise.
final class SegmentFile: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    let path: String
    var indexPath: String { path + ".segments" }
    private let lock = NSLock()
    private var data: FileHandle?
    private var index: FileHandle?
    private(set) var bytes: Int64 = 0
    private(set) var records: [SegmentRecord] = []
    private(set) var failure: String?
    private var hasher = SHA256()
    /// The SHA-256 of the whole file, hex, once closed after every segment was written (nil otherwise).
    private(set) var sha256: String?
    /// Called (on the writer's queue) once a segment is on disk.
    var onSegment: ((SegmentRecord) -> Void)?

    init(path: String) throws {
        self.path = path
        super.init()
        let fm = FileManager.default
        try? fm.removeItem(atPath: path)
        try? fm.removeItem(atPath: indexPath)
        guard fm.createFile(atPath: path, contents: nil), fm.createFile(atPath: indexPath, contents: nil),
              let data = FileHandle(forWritingAtPath: path), let index = FileHandle(forWritingAtPath: indexPath) else {
            throw Fail("could not create \(path)")
        }
        self.data = data
        self.index = index
    }

    func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
        let kind = segmentType == .initialization ? "init" : "media"
        var end: Double?
        if let track = segmentReport?.trackReports.first {
            let e = CMTimeAdd(track.earliestPresentationTimeStamp, track.duration)
            if e.isNumeric { end = e.seconds }
        }
        lock.lock()
        guard let data, let index, failure == nil else { lock.unlock(); return }
        let record = SegmentRecord(index: records.count, kind: kind, offset: bytes, length: segmentData.count, endSeconds: end)
        do {
            try data.write(contentsOf: segmentData)
            try data.synchronize()
            var line = "\(kind) \(record.offset) \(record.length)"
            if let end { line += " \(String(format: "%.6f", end))" }
            try index.write(contentsOf: Data((line + "\n").utf8))
            try index.synchronize()
            hasher.update(data: segmentData)
            bytes += Int64(segmentData.count)
            records.append(record)
        } catch {
            failure = "could not write \((path as NSString).lastPathComponent): \(error.localizedDescription)"
        }
        let ok = failure == nil
        lock.unlock()
        if ok { onSegment?(record) }
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        if data != nil && failure == nil { sha256 = hasher.finalize().map { String(format: "%02x", $0) }.joined() }
        try? data?.close(); try? index?.close()
        data = nil; index = nil
    }
    var segments: Int { lock.lock(); defer { lock.unlock() }; return records.count }
}

/// An AVAssetWriter that hands its output to `file` in segments (fragmented
/// MP4, Apple's HLS profile), its media starting at time 0.
func segmentedWriter(_ file: SegmentFile) -> AVAssetWriter {
    let writer = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
    writer.outputFileTypeProfile = .mpeg4AppleHLS
    writer.preferredOutputSegmentInterval = segmentInterval
    writer.initialSegmentStartTime = .zero
    writer.delegate = file
    return writer
}

/// The take's start (the screen's first frame, host seconds) and its end,
/// shared with the capture queues of every other source. Before `begin`, they
/// hold their newest picture and drop audio; after `halt` they drop everything.
final class CaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var origin: Double?
    private var halted = false
    func begin(_ t0: Double) { lock.lock(); origin = t0; lock.unlock() }
    func halt() { lock.lock(); halted = true; lock.unlock() }
    var state: (t0: Double?, halted: Bool) { lock.lock(); defer { lock.unlock() }; return (origin, halted) }
}

/// A copy of `sample` shifted by `delta` seconds (every timing entry).
func shifted(_ sample: CMSampleBuffer, by delta: Double) -> CMSampleBuffer? {
    if abs(delta) < 1e-9 { return sample }
    var count: CMItemCount = 0
    guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr, count > 0 else { return nil }
    var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
    guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count) == noErr else { return nil }
    let d = CMTime(seconds: delta, preferredTimescale: 1_000_000_000)
    for i in timing.indices {
        if timing[i].presentationTimeStamp.isValid { timing[i].presentationTimeStamp = CMTimeAdd(timing[i].presentationTimeStamp, d) }
        if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = CMTimeAdd(timing[i].decodeTimeStamp, d) }
    }
    var copy: CMSampleBuffer?
    return CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: count,
                                                 sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr ? copy : nil
}

/// Encoder settings for a picture of `width`×`height` at `fps`: what the
/// Studio's import would otherwise make of it (studio-worker/src/assets.ts
/// conformArgs) and what its fast export reads as it is (fast-export.ts
/// sourcesFit): H.264, 4:2:0 in limited range, tagged BT.709 (a display's own
/// colours are converted to it), a key frame every second, no reordered
/// frames. H.264 tops out at 4096 px a side; larger screens (5K, 6K) are
/// written as HEVC, which the import still conforms.
func videoSettings(width: Int, height: Int, fps: Int, screen: Bool) -> (settings: [String: Any], codec: String) {
    let hevc = max(width, height) > 4096
    // Screen content is mostly still text: an average budget of ~0.12 bits per
    // pixel per frame keeps text crisp through the edit; capped so an hour of
    // a large display stays uploadable. HEVC needs about two thirds of it.
    let pixelsPerSecond = Double(width * height * fps)
    var bitrate = min(screen ? 60_000_000 : 16_000_000, max(screen ? 8_000_000 : 4_000_000, pixelsPerSecond * (screen ? 0.12 : 0.08)))
    if hevc { bitrate *= 0.66 }
    var compression: [String: Any] = [
        AVVideoAverageBitRateKey: Int(bitrate),
        AVVideoExpectedSourceFrameRateKey: fps,
        // A key frame every second, as the import's conform (`-g fps`).
        AVVideoMaxKeyFrameIntervalKey: fps,
        AVVideoMaxKeyFrameIntervalDurationKey: 1,
        // Frames in time order: every packet's time is its frame's.
        AVVideoAllowFrameReorderingKey: false,
    ]
    compression[AVVideoProfileLevelKey] = hevc ? "HEVC_Main_AutoLevel" : AVVideoProfileLevelH264HighAutoLevel
    if !hevc { compression[AVVideoH264EntropyModeKey] = AVVideoH264EntropyModeCABAC }
    return ([
        AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoColorPropertiesKey: [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
        AVVideoCompressionPropertiesKey: compression,
    ], hevc ? "hevc" : "h264")
}

/// A picture track on an exact frame grid: slot k is shown at k / fps (the
/// file starts at 0); a slot holds the newest picture at or before its time,
/// and a picture that does not change is repeated, so every frame keeps time
/// however the source delivered them. Written in segments (SegmentFile).
/// Not thread-safe: one queue drives it.
final class GridVideo: @unchecked Sendable {
    let fps: Int
    let width: Int, height: Int
    let codec: String
    let file: SegmentFile
    private let writer: AVAssetWriter
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    /// The next slot to write: the slots written so far.
    private(set) var next: Int64 = 0
    /// Appends the encoder was too busy for (their slot stayed open).
    private(set) var misses = 0
    /// How long one append waits for a busy encoder, in half milliseconds.
    var patience = 200
    /// Set from any thread when the take ends: no more waiting.
    var stopping = false

    init(path: String, width: Int, height: Int, fps: Int, screen: Bool, scaleToFit: Bool = false) throws {
        self.width = width; self.height = height; self.fps = fps
        file = try SegmentFile(path: path)
        writer = segmentedWriter(file)
        var (settings, codec) = videoSettings(width: width, height: height, fps: fps, screen: screen)
        if scaleToFit { settings[AVVideoScalingModeKey] = AVVideoScalingModeResizeAspect }
        self.codec = codec
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        input.mediaTimeScale = videoTimeScale
        guard writer.canAdd(input) else { throw Fail("the encoder refused \(width)×\(height)") }
        writer.add(input)
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.startWriting() else { throw Fail("can't start \((path as NSString).lastPathComponent): \(writer.error?.localizedDescription ?? "?")") }
        writer.startSession(atSourceTime: .zero)
    }

    func time(_ slot: Int64) -> CMTime { CMTime(value: slot, timescale: CMTimeScale(fps)) }

    /// The slot a picture taken `seconds` after slot 0 belongs to.
    func slot(at seconds: Double) -> Int64 { Int64((seconds * Double(fps)).rounded()) }

    /// Write `pixel` into the next slot. False when the encoder stayed busy:
    /// the slot stays open for the next try, so the grid may lag a moment but
    /// never gets a hole.
    @discardableResult
    func put(_ pixel: CVPixelBuffer) -> Bool {
        let input = adaptor.assetWriterInput
        var waits = 0
        while !input.isReadyForMoreMediaData && waits < patience && !stopping { usleep(500); waits += 1 }
        guard input.isReadyForMoreMediaData, adaptor.append(pixel, withPresentationTime: time(next)) else { misses += 1; return false }
        next += 1
        return true
    }

    /// Repeat `pixel` into every open slot before `slot`.
    func fill(_ pixel: CVPixelBuffer, upTo slot: Int64) {
        while next < slot && !stopping { if !put(pixel) { return } }
    }

    /// A picture belonging to `slot`: the open slots before it get `previous`
    /// (the picture shown until now), then it takes its own slot, unless that
    /// one is already written (two pictures in one step: the caller keeps it
    /// as the newest picture for the next slot).
    func place(_ pixel: CVPixelBuffer, at slot: Int64, after previous: CVPixelBuffer?) {
        if let previous { fill(previous, upTo: slot) }
        if slot >= next { put(pixel) }
    }

    /// End after the last slot written and finalize the file. Nil when it is
    /// complete, else why not.
    func finish() async -> String? {
        stopping = true
        guard next > 0 else { writer.cancelWriting(); file.close(); return "no picture was written" }
        adaptor.assetWriterInput.markAsFinished()
        writer.endSession(atSourceTime: time(next))
        await writer.finishWriting()
        file.close()
        if writer.status != .completed { return writer.error?.localizedDescription ?? "the file did not finalize" }
        return file.failure
    }
}

/// One picture source besides the screen: a camera or another app window,
/// written on its own grid (30 fps) on the screen's clock. Slot 0 is its first
/// picture (or t0, when a picture held from before the take covers it).
final class TrackWriter: @unchecked Sendable {
    let role: String, kind: String, sourceID: String, name: String, path: String
    let fps = 30
    private let gate: CaptureGate
    private let lock = NSLock()
    private var grid: GridVideo?
    /// Host seconds of slot 0.
    private var origin: Double?
    private var last: CVPixelBuffer?
    private var held: CVPixelBuffer?
    private(set) var width = 0, height = 0
    private(set) var codec = "h264"
    var failure: String?
    /// Called once the file exists (its first segment is on the way), with the host seconds of its time 0.
    var onOpen: ((SegmentFile, Double) -> Void)?
    init(role: String, kind: String, sourceID: String, name: String, path: String, gate: CaptureGate) {
        self.role = role; self.kind = kind; self.sourceID = sourceID; self.name = name; self.path = path; self.gate = gate
    }
    /// `seconds`: the picture's time on the host clock.
    func append(_ sample: CMSampleBuffer, hostSeconds seconds: Double) {
        guard let pixel = CMSampleBufferGetImageBuffer(sample) else { return }
        append(pixel, hostSeconds: seconds)
    }
    func append(_ pixel: CVPixelBuffer, hostSeconds seconds: Double) {
        let (t0, halted) = gate.state
        guard !halted, seconds.isFinite else { return }
        lock.lock(); defer { lock.unlock() }
        // Before the take starts keep the newest picture: a window that is not
        // changing still has a picture at t0.
        guard let t0, seconds >= t0 else { held = pixel; return }
        if grid == nil {
            if let held, seconds > t0 { open(with: held, at: t0); last = held } else { open(with: pixel, at: seconds) }
            held = nil
        }
        guard let grid, let origin else { return }
        grid.place(pixel, at: grid.slot(at: seconds - origin), after: last)
        last = pixel
    }
    private func open(with pixel: CVPixelBuffer, at seconds: Double) {
        let w = CVPixelBufferGetWidth(pixel), h = CVPixelBufferGetHeight(pixel)
        let fit = min(1.0, 4096.0 / Double(max(w, h)))
        width = max(2, Int(Double(w) * fit) & ~1); height = max(2, Int(Double(h) * fit) & ~1)
        do {
            let video = try GridVideo(path: path, width: width, height: height, fps: fps, screen: kind == "window", scaleToFit: true)
            codec = video.codec
            grid = video; origin = seconds
            onOpen?(video.file, seconds)
        } catch let f as Fail { failure = "Could not create the \(kind) track: \(f.message)" } catch { failure = error.localizedDescription }
    }
    /// Windows only send pictures when they change: the last one is held until
    /// `end` (Stop) so the track covers the whole take.
    func finish(holdUntil end: Double?) async -> [String: Any] {
        let (active, start) = { () -> (GridVideo?, Double?) in
            lock.lock(); defer { lock.unlock() }
            if let grid, let origin, let last, let end { grid.fill(last, upTo: grid.slot(at: end - origin)) }
            last = nil; held = nil
            return (grid, origin)
        }()
        var error = failure
        if let active, let problem = await active.finish(), error == nil { error = problem }
        let frames = active?.next ?? 0
        let finalized = error == nil && frames > 0
        var row: [String: Any] = ["role": role, "kind": kind, "sourceId": sourceID, "name": name, "path": path,
                                  "finalized": finalized, "frames": frames, "width": width, "height": height, "codec": codec,
                                  "fps": Double(fps), "firstPts": jsonNumber(start),
                                  "lastPts": jsonNumber(start.map { $0 + Double(frames) / Double(fps) }),
                                  "segments": active?.file.segments ?? 0, "gridMisses": active?.misses ?? 0,
                                  "sha256": active?.file.sha256 ?? NSNull()]
        if frames > 0 { row["durationSeconds"] = Double(frames) / Double(fps) }
        if let error = error ?? (finalized ? nil : "No picture was captured from \(name)") { row["error"] = error }
        return row
    }
}

/// The silence Apple's AAC encoder puts before the first sample (its priming,
/// 2112 samples at 48 kHz). A segmented file has no edit list to skip it, so
/// every decoder plays it: the file's time 0 is this long before its first
/// captured sample (WriterTests decodes a file to prove it).
let aacPrimingSeconds = 2112.0 / 48_000

/// The longest stretch of missing sound put back as silence. A larger jump in the times is not sound that went
/// missing but a clock that jumped (a device switched, a host clock resynced): nothing is filled, and the file goes on
/// from where it is (its time 0 moves by the jump).
let silenceFillMaxSeconds = 5.0

/// What a buffer's PCM is: its rate, channels and layout. The encoder takes the format of the first buffer for the
/// whole file: AVAssetWriter accepts a buffer of another rate mid-take but encodes it as if it were the first rate (a
/// 24 kHz microphone after 48 kHz plays at twice the speed, its time wrong, and no error is raised: WriterTests), so a
/// change ends the track there, cleanly.
struct PCMFormat: Equatable {
    let rate: Double, channels: UInt32, flags: AudioFormatFlags, bits: UInt32
    init?(_ sample: CMSampleBuffer) {
        guard let asbd = CMSampleBufferGetFormatDescription(sample).flatMap({ CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }),
              asbd.mSampleRate > 0 else { return nil }
        rate = asbd.mSampleRate; channels = asbd.mChannelsPerFrame; flags = asbd.mFormatFlags; bits = asbd.mBitsPerChannel
    }
}

/// An AAC audio file written from PCM sample buffers on the screen's clock,
/// in segments, its first sample written at time 0 (and heard at
/// aacPrimingSeconds).
///
/// The encoder joins its input end to end whatever the times say, so sound that never came (a buffer the device did
/// not deliver, or one the busy encoder could not take) is put back as silence, and what follows keeps its time. A gap
/// is told from the times of two buffers in a row: this one starts later than the last one ended by at least half a
/// buffer (10 ms at the least). Jitter (a few ms either way) never reaches that, and a clock that drifts (tens of ppm)
/// moves each buffer by nanoseconds, so neither ever puts in silence (an earlier version compared each buffer with
/// everything written so far and turned drift into clicks). A jump past silenceFillMaxSeconds is a clock jump: not
/// filled. Time that goes backwards is not taken back: the sound goes on. Nothing here ever waits: a busy encoder's
/// buffer is dropped and the next one fills its place with silence.
final class AudioFileWriter: @unchecked Sendable {
    let role: String, path: String, channels: Int
    private let gate: CaptureGate
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private(set) var file: SegmentFile?
    private(set) var buffers = 0
    private(set) var drops = 0
    /// Seconds of silence put where sound never came.
    private(set) var filledSeconds = 0.0
    /// Seconds of the file written so far (sound and silence): where the next buffer goes in it.
    private var writtenSeconds = 0.0
    /// Host seconds the last buffer written ended at: where the next one should start.
    private var expected: Double?
    /// The format of the first buffer: the file's.
    private var format: PCMFormat?
    /// Why the track ended before the take did (a format the encoder could not go on with), in plain words.
    private(set) var ended: String?
    /// Host seconds of the first sample captured (written at the file's time 0).
    private(set) var firstPTS: Double?
    /// Host seconds of the file's time 0 as it plays: before the first sample by the encoder's priming.
    var fileStart: Double? { firstPTS.map { $0 - aacPrimingSeconds } }
    private(set) var lastPTS: Double?
    var failure: String?
    /// Called once the file exists, with the host seconds of its time 0 as it plays.
    var onOpen: ((SegmentFile, Double) -> Void)?
    /// Whether the encoder takes `piece` now, besides its own readiness (tests stand in for a busy encoder here).
    var takes: (CMSampleBuffer) -> Bool = { _ in true }
    init(role: String, path: String, channels: Int, gate: CaptureGate) {
        self.role = role; self.path = path; self.channels = channels; self.gate = gate
    }
    /// Append `sample` (stamped `seconds` on the host clock). Returns whether
    /// it was written: false before the take starts, after it ends, when the
    /// encoder is behind (the next buffer fills its place), or once the track
    /// ended (a change of format).
    @discardableResult
    func append(_ sample: CMSampleBuffer, hostSeconds seconds: Double) -> Bool {
        let (t0, halted) = gate.state
        guard !halted, let t0, seconds.isFinite, seconds >= t0, CMSampleBufferGetNumSamples(sample) > 0 else { return false }
        guard CMSampleBufferDataIsReady(sample), let pcm = PCMFormat(sample) else { drops += 1; return false }
        let stamp = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        let duration = Double(CMSampleBufferGetNumSamples(sample)) / pcm.rate
        lock.lock(); defer { lock.unlock() }
        if ended != nil { return false }
        if writer == nil && failure == nil { open(at: seconds); format = pcm }
        guard let input, let first = format else { drops += 1; return false }
        if pcm != first {
            ended = "The \(role == "system-audio" ? "system sound" : role) changed its format mid-take (\(Int(first.rate)) Hz to \(Int(pcm.rate)) Hz): its recording ends there."
            return false
        }
        if let expected {
            let jump = seconds - expected
            if jump >= max(0.5 * duration, 0.010) && jump <= silenceFillMaxSeconds {
                // Missing sound: silence of the same length, in pieces of at most a second. Each piece that goes in moves
                // `expected` on by its length: should the encoder stop taking them partway, the next buffer fills only
                // what is still missing (never the whole gap again).
                var left = jump, quiet: [CMSampleBuffer] = []
                var at = writtenSeconds
                while left > 0.5 / pcm.rate {
                    let frames = max(1, Int((min(left, 1) * pcm.rate).rounded()))
                    guard let piece = silence(like: sample, frames: frames, at: CMTime(seconds: at, preferredTimescale: CMTimeScale(pcm.rate))) else { break }
                    quiet.append(piece)
                    at += Double(frames) / pcm.rate; left -= Double(frames) / pcm.rate
                }
                for piece in quiet {
                    guard input.isReadyForMoreMediaData, takes(piece), input.append(piece) else { drops += 1; return false }
                    let added = Double(CMSampleBufferGetNumSamples(piece)) / pcm.rate
                    writtenSeconds += added; filledSeconds += added
                    self.expected = (self.expected ?? seconds) + added
                }
                // The file has reached this buffer's start: should it not go in now, it is not filled for twice.
                self.expected = seconds
            }
        }
        guard input.isReadyForMoreMediaData, takes(sample), let onFile = shifted(sample, by: writtenSeconds - stamp), input.append(onFile) else {
            // Its place is filled with silence by the next buffer.
            drops += 1; return false
        }
        buffers += 1
        writtenSeconds += duration
        expected = seconds + duration
        lastPTS = seconds + duration
        return true
    }
    private func open(at seconds: Double) {
        do {
            let segments = try SegmentFile(path: path)
            let newWriter = segmentedWriter(segments)
            let newInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 128_000 : 192_000,
            ])
            newInput.expectsMediaDataInRealTime = true
            guard newWriter.canAdd(newInput) else { failure = "Could not create the \(role) track"; return }
            newWriter.add(newInput)
            guard newWriter.startWriting() else { failure = newWriter.error?.localizedDescription ?? "Could not start the \(role) track"; return }
            newWriter.startSession(atSourceTime: .zero)
            writer = newWriter; input = newInput; file = segments; firstPTS = seconds
            onOpen?(segments, seconds - aacPrimingSeconds)
        } catch let f as Fail { failure = f.message } catch { failure = error.localizedDescription }
    }
    func finish() async -> [String: Any] {
        let (activeWriter, activeInput, segments) = { lock.lock(); defer { lock.unlock() }; return (writer, input, file) }()
        var error = failure
        let endedEarly = { lock.lock(); defer { lock.unlock() }; return ended }()
        if let activeWriter, let activeInput {
            activeInput.markAsFinished()
            await activeWriter.finishWriting()
            segments?.close()
            if activeWriter.status != .completed { error = error ?? activeWriter.error?.localizedDescription ?? "The \(role) file did not finalize" }
            error = error ?? segments?.failure
        }
        let finalized = error == nil && writer?.status == .completed && buffers > 0
        var row: [String: Any] = ["role": role, "path": path, "finalized": finalized, "codec": "aac", "sampleRate": 48_000,
                                  "channels": channels, "buffers": buffers, "droppedBuffers": drops,
                                  "firstPts": jsonNumber(fileStart), "capturedPts": jsonNumber(firstPTS), "primingSeconds": aacPrimingSeconds,
                                  "lastPts": jsonNumber(lastPTS), "segments": segments?.segments ?? 0, "silenceFilledSeconds": filledSeconds,
                                  "sha256": segments?.sha256 ?? NSNull()]
        // The file's own length (sound and silence, after the encoder's priming): what plays, whatever the clock did.
        if writtenSeconds > 0 { row["durationSeconds"] = writtenSeconds + aacPrimingSeconds }
        if let endedEarly { row["endedEarly"] = endedEarly }
        if let error = error ?? (finalized ? nil : "No \(role) audio was captured") { row["error"] = error }
        return row
    }
}

/// `frames` of silence in the format of `sample` (any PCM layout), stamped `pts`.
func silence(like sample: CMSampleBuffer, frames: Int, at pts: CMTime) -> CMSampleBuffer? {
    guard frames > 0, let format = CMSampleBufferGetFormatDescription(sample),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee, asbd.mBytesPerFrame > 0 else { return nil }
    let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    let length = Int(asbd.mBytesPerFrame) * frames * (planar ? Int(max(1, asbd.mChannelsPerFrame)) : 1)
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: length, blockAllocator: nil, customBlockSource: nil,
                                             offsetToData: 0, dataLength: length, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
          let block, CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: length) == noErr else { return nil }
    var out: CMSampleBuffer?
    return CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
                                                                presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &out) == noErr ? out : nil
}

/// Root-mean-square of the float samples in an audio sample buffer (all
/// channels), and optionally the first channel's samples.
func audioRMS(_ sample: CMSampleBuffer, collectFirstChannel: Bool = false) -> (rms: Float, mono: [Float]) {
    var blockBuffer: CMBlockBuffer?
    var sizeNeeded = 0
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil) == noErr, sizeNeeded > 0 else { return (0, []) }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: sizeNeeded,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer) == noErr else { return (0, []) }
    guard let format = CMSampleBufferGetFormatDescription(sample),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM, asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return (0, []) }
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    var sum: Float = 0, count = 0
    var mono: [Float] = []
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let channels = max(1, Int(asbd.mChannelsPerFrame))
    for (index, buffer) in buffers.enumerated() {
        guard let data = buffer.mData else { continue }
        let n = Int(buffer.mDataByteSize) / 4
        let floats = data.bindMemory(to: Float.self, capacity: n)
        for i in 0..<n { let v = floats[i]; sum += v * v }
        count += n
        if collectFirstChannel && index == 0 {
            if interleaved && channels > 1 {
                mono.reserveCapacity(n / channels)
                var i = 0
                while i < n { mono.append(floats[i]); i += channels }
            } else {
                mono.append(contentsOf: UnsafeBufferPointer(start: floats, count: n))
            }
        }
    }
    return (count > 0 ? (sum / Float(count)).squareRoot() : 0, mono)
}

/// 48 kHz → 16 kHz for the on-device transcription: a 2nd-order low-pass at
/// 7 kHz, then every third sample.
final class Decimator {
    private var x1: Float = 0, x2: Float = 0, y1: Float = 0, y2: Float = 0
    private var phase = 0
    private let b0: Float, b1: Float, b2: Float, a1: Float, a2: Float
    init() {
        let fs = 48_000.0, f0 = 7_000.0, q = 0.7071
        let w0 = 2 * Double.pi * f0 / fs, alpha = sin(w0) / (2 * q), c = cos(w0), a0 = 1 + alpha
        b0 = Float((1 - c) / 2 / a0); b1 = Float((1 - c) / a0); b2 = b0
        a1 = Float(-2 * c / a0); a2 = Float((1 - alpha) / a0)
    }
    func process(_ input: [Float]) -> [Float] {
        var out: [Float] = []
        out.reserveCapacity(input.count / 3 + 1)
        for x in input {
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x; y2 = y1; y1 = y
            if phase == 0 { out.append(y) }
            phase = (phase + 1) % 3
        }
        return out
    }
}
