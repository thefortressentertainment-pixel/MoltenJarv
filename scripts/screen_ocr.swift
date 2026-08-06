import Foundation
import Vision
import AppKit

// screen_ocr — on-device text extraction from an image using macOS Vision.
// Usage: screen_ocr <imagePath> [--lines] [--json]
//
// Zero model download, no GPU/Ollama needed: the Vision framework ships with
// macOS. Prints recognized text lines to stdout (top-to-bottom, left-to-right).

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: screen_ocr <imagePath> [--lines] [--json]\n".data(using: .utf8)!)
    exit(2)
}

let imagePath = args[1]
let wantLines = args.contains("--lines")
let wantJSON = args.contains("--json")

guard let img = NSImage(contentsOfFile: imagePath) else {
    FileHandle.standardError.write("ERROR: could not load image at \(imagePath)\n".data(using: .utf8)!)
    exit(1)
}
guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("ERROR: could not convert image\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.01

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("ERROR: \(error)\n".data(using: .utf8)!)
    exit(1)
}

let results = request.results ?? []
if wantJSON {
    var items: [String] = []
    for obs in results {
        if let top = obs.topCandidates(1).first {
            let b = obs.boundingBox
            items.append("{\"text\":\"\(top.string.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\",\"x\":\(b.origin.x),\"y\":\(b.origin.y),\"w\":\(b.size.width),\"h\":\(b.size.height)}")
        }
    }
    print("[\(items.joined(separator: ","))]")
} else {
    for obs in results {
        if let top = obs.topCandidates(1).first {
            print(top.string)
        }
    }
}
