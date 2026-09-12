// Renderiza páginas de un PDF a PNG (para OCR de programas escaneados).
// Uso: pdf-a-png <pdf>            -> imprime nº de páginas
//      pdf-a-png <pdf> <n> <png>  -> renderiza la página n (1-based) a 2x
// Compilar: swiftc -O scripts/pdf-a-png.swift -o .cache/pdf-a-png
import Foundation
import PDFKit
import AppKit

let args = CommandLine.arguments
guard args.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { exit(1) }
if args.count == 2 {
    print(doc.pageCount)
    exit(0)
}
guard args.count > 3, let n = Int(args[2]), n >= 1, n <= doc.pageCount,
      let page = doc.page(at: n - 1) else { exit(2) }
let rect = page.bounds(for: .mediaBox)
let scale: CGFloat = 2.0
let size = NSSize(width: rect.width * scale, height: rect.height * scale)
let img = NSImage(size: size)
img.lockFocus()
NSColor.white.set()
NSRect(origin: .zero, size: size).fill()
if let ctx = NSGraphicsContext.current?.cgContext {
    ctx.saveGState()
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    ctx.restoreGState()
}
img.unlockFocus()
if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: args[3]))
}
