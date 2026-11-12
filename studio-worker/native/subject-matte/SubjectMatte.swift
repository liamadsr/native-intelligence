// Cuts the subject out of a video with macOS Vision and writes a greyscale matte video (white = subject) with the
// same frame timing as the source. The Studio worker merges it with the source into a cut-out (a transparent VP9
// WebM, src/jobs/cutout.ts) the composition can draw on top of text, so words sit *behind* the speaker.
//
//   subject-matte <input> <output.mov> [--mode person|subject] [--max-side 960]
// Prints JSON progress lines: {"progress":0.42} … {"done":true,"frames":N,"width":W,"height":H}
import AVFoundation
import CoreImage
import Foundation
import Vision

struct Failure: Error, CustomStringConvertible { let description: String }
func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}

@main
struct SubjectMatte {
  static func main() async {
    do { try await run() } catch { emit(["error": "\(error)"]); exit(1) }
  }

  static func run() async throws {
    var args = Array(CommandLine.arguments.dropFirst())
    func option(_ name: String) -> String? { guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }; let v = args[i + 1]; args.removeSubrange(i...(i + 1)); return v }
    let mode = option("--mode") ?? "person", maxSide = Int(option("--max-side") ?? "960") ?? 960
    guard args.count == 2 else { throw Failure(description: "usage: subject-matte <input> <output.mov> [--mode person|subject] [--max-side 960]") }
    let input = URL(fileURLWithPath: args[0]), output = URL(fileURLWithPath: args[1])
    try? FileManager.default.removeItem(at: output)

    let asset = AVURLAsset(url: input)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure(description: "no video track") }
    let natural = try await track.load(.naturalSize), transform = try await track.load(.preferredTransform), duration = try await asset.load(.duration)
    let oriented = natural.applying(transform), srcW = abs(oriented.width), srcH = abs(oriented.height)
    let scale = min(1, Double(maxSide) / Double(max(srcW, srcH)))
    let outW = Int((Double(srcW) * scale / 2).rounded()) * 2, outH = Int((Double(srcH) * scale / 2).rounded()) * 2

    let reader = try AVAssetReader(asset: asset)
    let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    readerOutput.alwaysCopiesSampleData = false
    reader.add(readerOutput)

    let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
    let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: outW, AVVideoHeightKey: outH,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000, AVVideoMaxKeyFrameIntervalKey: 30]])
    writerInput.transform = .identity
    writerInput.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: writerInput, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: outW, kCVPixelBufferHeightKey as String: outH])
    writer.add(writerInput)
    guard reader.startReading() else { throw Failure(description: "cannot read input: \(reader.error.map { "\($0)" } ?? "unknown")") }
    guard writer.startWriting() else { throw Failure(description: "cannot write output: \(writer.error.map { "\($0)" } ?? "unknown")") }

    let context = CIContext(options: [.cacheIntermediates: false])
    let person = VNGeneratePersonSegmentationRequest()
    person.qualityLevel = .accurate
    person.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let subject = VNGenerateForegroundInstanceMaskRequest()
    var started = false, frames = 0, lastReport = -1.0
    var previous: CIImage?
    let total = max(0.001, duration.seconds)

    while let sample = readerOutput.copyNextSampleBuffer() {
      guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
      let time = CMSampleBufferGetPresentationTimeStamp(sample)
      if !started { writer.startSession(atSourceTime: time); started = true }
      let orientation = cgOrientation(transform)
      let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: orientation)
      var matte: CIImage?
      if mode == "subject" {
        try handler.perform([subject])
        if let observation = subject.results?.first, !observation.allInstances.isEmpty {
          let mask = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
          matte = CIImage(cvPixelBuffer: mask)
        }
      } else {
        try handler.perform([person])
        if let mask = person.results?.first?.pixelBuffer { matte = CIImage(cvPixelBuffer: mask) }
      }
      var image = matte ?? CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
      image = image.transformed(by: CGAffineTransform(scaleX: CGFloat(outW) / image.extent.width, y: CGFloat(outH) / image.extent.height))
      // A touch of temporal smoothing keeps hair edges from shimmering.
      if let last = previous, matte != nil {
        image = image.applyingFilter("CIDissolveTransition", parameters: [kCIInputTargetImageKey: last, kCIInputTimeKey: 0.25])
      }
      previous = image
      while !writerInput.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
      guard let pool = adaptor.pixelBufferPool else { throw Failure(description: "no pixel buffer pool") }
      var out: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
      guard let buffer = out else { throw Failure(description: "cannot allocate frame") }
      context.render(image.clampedToExtent().cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH)), to: buffer, bounds: CGRect(x: 0, y: 0, width: outW, height: outH), colorSpace: CGColorSpaceCreateDeviceRGB())
      if !adaptor.append(buffer, withPresentationTime: time) { throw Failure(description: "write failed: \(writer.error.map { "\($0)" } ?? "unknown")") }
      frames += 1
      let progress = min(1, time.seconds / total)
      if progress - lastReport >= 0.02 { emit(["progress": (progress * 1000).rounded() / 1000]); lastReport = progress }
    }
    if reader.status == .failed { throw Failure(description: "read failed: \(reader.error.map { "\($0)" } ?? "unknown")") }
    writerInput.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed { throw Failure(description: "finish failed: \(writer.error.map { "\($0)" } ?? "unknown")") }
    emit(["done": true, "frames": frames, "width": outW, "height": outH])
  }

  static func cgOrientation(_ t: CGAffineTransform) -> CGImagePropertyOrientation {
    switch (t.a, t.b, t.c, t.d) {
    case (0, 1, -1, 0): return .right
    case (0, -1, 1, 0): return .left
    case (-1, 0, 0, -1): return .down
    default: return .up
    }
  }
}
