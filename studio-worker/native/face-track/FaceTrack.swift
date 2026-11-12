// Where the person is in a camera recording, a few times a second, with macOS Vision: each face's box (0–1, top-left
// origin), which way it is turned (yaw: 0 = straight at the lens, ± = turned left/right; pitch; roll) and how sure
// Vision is. The director pass uses it to pick the angle you're facing, and a narrower format to keep the face in
// frame (src/jobs/faces.ts).
//
//   face-track <input> [--every 0.2] [--max-side 640]
// Prints JSON lines: {"t":1.2,"faces":[{"x":…,"y":…,"w":…,"h":…,"yaw":…,"pitch":…,"roll":…,"confidence":…}]} … {"done":true,"samples":N}
import AVFoundation
import CoreImage
import Foundation
import Vision

struct Failure: Error, CustomStringConvertible { let description: String }
func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}

@main
struct FaceTrack {
  static func main() async {
    do { try await run() } catch { emit(["error": "\(error)"]); exit(1) }
  }

  static func run() async throws {
    var args = Array(CommandLine.arguments.dropFirst())
    func option(_ name: String) -> String? { guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }; let v = args[i + 1]; args.removeSubrange(i...(i + 1)); return v }
    let every = Double(option("--every") ?? "0.2") ?? 0.2, maxSide = Double(option("--max-side") ?? "640") ?? 640
    guard args.count == 1 else { throw Failure(description: "usage: face-track <input> [--every 0.2] [--max-side 640]") }
    let asset = AVURLAsset(url: URL(fileURLWithPath: args[0]))
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure(description: "no video track") }
    let natural = try await track.load(.naturalSize), transform = try await track.load(.preferredTransform)
    let oriented = natural.applying(transform), scale = min(1, maxSide / Double(max(abs(oriented.width), abs(oriented.height))))
    let width = Int((Double(abs(natural.width)) * scale / 2).rounded()) * 2, height = Int((Double(abs(natural.height)) * scale / 2).rounded()) * 2
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { throw Failure(description: reader.error.map { "\($0)" } ?? "cannot read") }
    let orientation = cgOrientation(transform)
    var next = 0.0, samples = 0
    while let buffer = output.copyNextSampleBuffer() {
      let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
      guard t + 1e-6 >= next, let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
      next = t + every
      let request = VNDetectFaceRectanglesRequest()
      if #available(macOS 12.0, *) { request.revision = VNDetectFaceRectanglesRequestRevision3 }
      try VNImageRequestHandler(cvPixelBuffer: pixels, orientation: orientation, options: [:]).perform([request])
      let faces: [[String: Any]] = (request.results ?? []).map { face in
        let b = face.boundingBox
        var out: [String: Any] = ["x": r(b.minX), "y": r(1 - b.maxY), "w": r(b.width), "h": r(b.height), "confidence": r(Double(face.confidence))]
        if let yaw = face.yaw { out["yaw"] = r(yaw.doubleValue) }
        if let roll = face.roll { out["roll"] = r(roll.doubleValue) }
        if #available(macOS 12.0, *), let pitch = face.pitch { out["pitch"] = r(pitch.doubleValue) }
        return out
      }
      emit(["t": r(t), "faces": faces]); samples += 1
    }
    if reader.status == .failed { throw Failure(description: reader.error.map { "\($0)" } ?? "read failed") }
    emit(["done": true, "samples": samples])
  }
  static func r(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
  static func r(_ v: CGFloat) -> Double { r(Double(v)) }
  /// The pixel buffer is the track's stored orientation; Vision needs to know how it is shown.
  static func cgOrientation(_ t: CGAffineTransform) -> CGImagePropertyOrientation {
    switch (t.a, t.b, t.c, t.d) {
    case (0, 1, -1, 0): return .right
    case (0, -1, 1, 0): return .left
    case (-1, 0, 0, -1): return .down
    default: return .up
    }
  }
}
