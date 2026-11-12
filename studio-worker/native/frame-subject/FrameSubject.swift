// Where the person is in still frames, with macOS Vision: a person matte (PGM, white = person) and each face's box
// (0–1, top-left origin). The visual check uses it to see whether text and overlays land on the speaker
// (src/vision/subject.ts: facesAndPersonAt).
//
//   frame-subject <frame.png> [<frame.png> …]
// Prints one JSON line per frame: {"file":…,"mask":"<frame>.person.pgm","faces":[{"x","y","w","h","confidence"}]}
import CoreImage
import Foundation
import ImageIO
import Vision

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}

@main
struct FrameSubject {
  static func main() {
    let files = Array(CommandLine.arguments.dropFirst())
    if files.isEmpty { emit(["error": "usage: frame-subject <frame.png> …"]); exit(2) }
    for path in files {
      guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        emit(["file": path, "error": "unreadable image"]); continue }
      let handler = VNImageRequestHandler(cgImage: image, options: [:])
      let person = VNGeneratePersonSegmentationRequest(); person.qualityLevel = .accurate; person.outputPixelFormat = kCVPixelFormatType_OneComponent8
      let faces = VNDetectFaceRectanglesRequest()
      var out: [String: Any] = ["file": path]
      do { try handler.perform([person, faces]) } catch { emit(["file": path, "error": "\(error)"]); continue }
      if let buffer = person.results?.first?.pixelBuffer {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer), row = CVPixelBufferGetBytesPerRow(buffer)
        if let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) {
          var data = Data("P5\n\(w) \(h)\n255\n".utf8)
          for y in 0..<h { data.append(base + y * row, count: w) }
          let maskPath = path + ".person.pgm"
          if (try? data.write(to: URL(fileURLWithPath: maskPath))) != nil { out["mask"] = maskPath }
        }
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
      }
      out["faces"] = (faces.results ?? []).map { f -> [String: Double] in let b = f.boundingBox
        return ["x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height), "confidence": Double(f.confidence)] }
      emit(out)
    }
  }
}
