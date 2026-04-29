// Acrofox OCR helper — Apple Vision text recognition on an image file.
//
// Usage: ocr-bin <path-to-png-or-jpeg>
// Output: JSON array on stdout, one object per recognized region:
//   { "text": string, "x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1, "confidence": 0..1 }
// Coordinates are normalised (0..1) with bottom-left origin — matches Vision's
// own VNRecognizedTextObservation.boundingBox convention. The caller
// multiplies by page width/height to place text in PDF points.
//
// Build: swiftc -O ocr.swift -o ocr-bin
// Runs entirely on-device; no network, no API keys.

import Foundation
import Vision
import AppKit

func emitError(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write("\(msg)\n".data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count > 1 else {
    emitError("usage: ocr-bin <image-path>", 2)
}

let imagePath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: url),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    emitError("failed to load image at \(imagePath)", 3)
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

do {
    try handler.perform([request])
} catch {
    emitError("vision perform: \(error.localizedDescription)", 4)
}

guard let observations = request.results else {
    // No text found — emit empty JSON array and exit cleanly.
    FileHandle.standardOutput.write("[]".data(using: .utf8)!)
    exit(0)
}

var out: [[String: Any]] = []
out.reserveCapacity(observations.count)

for obs in observations {
    guard let top = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox
    out.append([
        "text": top.string,
        "x": bb.origin.x,
        "y": bb.origin.y,
        "w": bb.size.width,
        "h": bb.size.height,
        "confidence": top.confidence,
    ])
}

do {
    let data = try JSONSerialization.data(withJSONObject: out, options: [])
    FileHandle.standardOutput.write(data)
} catch {
    emitError("json serialize: \(error.localizedDescription)", 5)
}
