import AVFoundation
import WebKit
import XCTest
@testable import studio_recorder

/// Does WebKit (the desktop app's view) trim AAC's priming? The editor's sound in that view is decoded by WebKit's
/// WebCodecs AudioDecoder, fed the file's packets by mediabunny (which only applies an edit list, and the recorder's
/// segmented file has none). So the microphone file is decoded here exactly that way, in an offscreen WKWebView (no
/// window), and the decoded sound compared with what was recorded: where the first recorded sample lands says whether
/// the 2112 samples of priming play first (as in FFmpeg and the export) or are dropped.
@MainActor
final class WebKitPrimingTests: XCTestCase {
    func testWebKitPlaysTheAACPrimingAsTheExportDoes() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("studio-recorder-webkit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("microphone.m4a").path
        let gate = CaptureGate()
        let writer = AudioFileWriter(role: "microphone", path: path, channels: 1, gate: gate)
        gate.begin(100)
        let helper = WriterTests()
        var first = 0
        while first < 48_000 * 2 {
            let sample = helper.pcm(first: first, count: 1024, seconds: 100 + Double(first) / 48_000)
            var tries = 0
            while !writer.append(sample, hostSeconds: 100 + Double(first) / 48_000) && tries < 200 { try await Task.sleep(nanoseconds: 1_000_000); tries += 1 }
            first += 1024
        }
        _ = await writer.finish()

        // The file's packets as a demuxer hands them over (no decoding), and the AudioSpecificConfig.
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var packets: [String] = []
        var cookie = Data()
        while let sample = output.copyNextSampleBuffer() {
            if cookie.isEmpty, let format = CMSampleBufferGetFormatDescription(sample) {
                var size = 0
                if let bytes = CMAudioFormatDescriptionGetMagicCookie(format, sizeOut: &size) { cookie = Data(bytes: bytes, count: size) }
            }
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let count = CMSampleBufferGetNumSamples(sample)
            var offset = 0
            for i in 0..<count {
                let size = CMSampleBufferGetSampleSize(sample, at: i)
                var data = Data(count: size)
                _ = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: size, destination: $0.baseAddress!) }
                packets.append(data.base64EncodedString())
                offset += size
            }
        }
        let asc = try XCTUnwrap(audioSpecificConfig(cookie), "the AAC configuration")

        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let loaded = expectation(description: "page")
        let delegate = Loaded { loaded.fulfill() }
        view.navigationDelegate = delegate
        view.loadHTMLString("<!doctype html><title>t</title>", baseURL: URL(string: "https://localhost/"))
        await fulfillment(of: [loaded], timeout: 20)
        let script = """
        if (typeof AudioDecoder === 'undefined') return { unsupported: true };
        const out = [];
        const decoder = new AudioDecoder({ output: (d) => { const n = d.numberOfFrames, buf = new Float32Array(n); d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' }); out.push({ t: d.timestamp, s: Array.from(buf) }); d.close(); }, error: (e) => out.push({ error: String(e) }) });
        const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        decoder.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, description: b64(asc) });
        packets.forEach((p, i) => decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * 1024 / 48000 * 1e6), data: b64(p) })));
        await decoder.flush();
        const err = out.find((o) => o.error);
        if (err) return { error: err.error };
        return { firstTimestamp: out[0].t, samples: out.flatMap((o) => o.s) };
        """
        let answer = try await view.callAsyncJavaScript(script, arguments: ["packets": packets, "asc": asc.base64EncodedString()], contentWorld: .page)
        let result = answer as? [String: Any]
        if result?["unsupported"] as? Bool == true { throw XCTSkip("This WebKit has no WebCodecs AudioDecoder") }
        XCTAssertNil(result?["error"], "\(result ?? [:])")
        let decoded = (result?["samples"] as? [NSNumber] ?? []).map { $0.doubleValue }
        XCTAssertEqual(decoded.count, packets.count * 1024, "every packet decodes to 1024 samples: nothing trimmed")
        // Where the recording sits in what WebKit plays: the lag that matches the recorded tone exactly.
        var best = (lag: -1, error: Double.infinity)
        for lag in 0...4096 {
            var e = 0.0
            for m in 40_000..<41_000 { e += pow(decoded[m] - WriterTests.chirp(m - lag), 2) }
            if e < best.error { best = (lag, e) }
        }
        print("WEBKIT_AAC_LAG \(best.lag) samples, error \(best.error / 1000), first timestamp \(result?["firstTimestamp"] ?? "?")")
        XCTAssertEqual(best.lag, 2112, "WebKit plays the 2112 samples of priming first, as FFmpeg and the export do")
        try? FileManager.default.removeItem(at: dir)
    }

    /// The AudioSpecificConfig inside an `esds` magic cookie (its DecoderSpecificInfo, tag 5).
    func audioSpecificConfig(_ cookie: Data) -> Data? {
        let bytes = [UInt8](cookie)
        var i = 0
        while i < bytes.count {
            if bytes[i] == 0x05 {
                var j = i + 1, size = 0
                for _ in 0..<4 { guard j < bytes.count else { return nil }; let b = bytes[j]; size = (size << 7) | Int(b & 0x7f); j += 1; if b & 0x80 == 0 { break } }
                if size > 0 && size <= 16 && j + size <= bytes.count { return Data(bytes[j..<(j + size)]) }
            }
            i += 1
        }
        return nil
    }
}

final class Loaded: NSObject, WKNavigationDelegate {
    let done: () -> Void
    init(_ done: @escaping () -> Void) { self.done = done }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
}
