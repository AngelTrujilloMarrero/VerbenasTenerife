// OCR de imágenes con el framework Vision de macOS (gratis, sin red).
// Uso: ocr-vision <img1> [img2 ...]   → texto por stdout (páginas con \f).
// Compilar: swiftc -O scripts/ocr-vision.swift -o .cache/ocr-vision
import Foundation
import Vision
import AppKit

let rutas = Array(CommandLine.arguments.dropFirst())
if rutas.isEmpty {
    FileHandle.standardError.write("uso: ocr-vision <img>...\n".data(using: .utf8)!)
    exit(2)
}
for (i, ruta) in rutas.enumerated() {
    if i > 0 { print("\u{000C}") }
    guard let img = NSImage(contentsOfFile: ruta),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("no se pudo abrir \(ruta)\n".data(using: .utf8)!)
        continue
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["es-ES", "es"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([req])
    } catch {
        FileHandle.standardError.write("fallo OCR \(ruta): \(error)\n".data(using: .utf8)!)
        continue
    }
    if let obs = req.results {
        for o in obs {
            if let t = o.topCandidates(1).first { print(t.string) }
        }
    }
}
