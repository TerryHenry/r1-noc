// Draws the app icon (1024px PNG): rounded square, gradient, "R1" mark.  swift icon.swift out.png
import Cocoa
let size = 1024; let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let r = NSRect(x: 40, y: 40, width: size - 80, height: size - 80); let path = NSBezierPath(roundedRect: r, xRadius: 190, yRadius: 190)
NSGradient(colors: [NSColor(red: 0.07, green: 0.12, blue: 0.22, alpha: 1), NSColor(red: 0.10, green: 0.36, blue: 0.80, alpha: 1)])!.draw(in: path, angle: -55)
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 430, weight: .heavy), .foregroundColor: NSColor.white]
let s = NSAttributedString(string: "R1", attributes: attrs); let sz = s.size(); s.draw(at: NSPoint(x: (CGFloat(size) - sz.width) / 2, y: (CGFloat(size) - sz.height) / 2 + 40))
NSColor(white: 1, alpha: 0.85).setFill()
for i in 0..<5 {
    let x: CGFloat = 250 + CGFloat(i) * 110
    let h: CGFloat = 40 + CGFloat(i % 3) * 30 + CGFloat(i) * 8
    NSBezierPath(roundedRect: NSRect(x: x, y: 215, width: 70, height: h), xRadius: 14, yRadius: 14).fill()
}
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!; try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
