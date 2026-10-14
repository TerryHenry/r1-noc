// Turns the supplied icon (artwork on a solid black backdrop) into a PNG with a transparent backdrop.
// Flood-fills from the image border over near-black pixels and makes them transparent, with a 1px soft edge.
//   swiftc make-alpha.swift -o make-alpha && ./make-alpha in.png out.png
import Cocoa
let a = CommandLine.arguments; guard a.count >= 3, let img = NSImage(contentsOfFile: a[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("cannot read input"); exit(1) }
let w = cg.width, h = cg.height; var px = [UInt8](repeating: 0, count: w * h * 4)
let cs = CGColorSpaceCreateDeviceRGB(); let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
func dark(_ i: Int) -> Bool { max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) <= 10 }
var out = [Bool](repeating: false, count: w * h); var queue = [Int](); queue.reserveCapacity(w * h / 4)
func seed(_ x: Int, _ y: Int) { let i = y * w + x; if !out[i] && dark(i) { out[i] = true; queue.append(i) } }
for x in 0..<w { seed(x, 0); seed(x, h - 1) }; for y in 0..<h { seed(0, y); seed(w - 1, y) }
var head = 0
while head < queue.count { let i = queue[head]; head += 1; let x = i % w, y = i / w
  if x > 0 { seed(x - 1, y) }; if x < w - 1 { seed(x + 1, y) }; if y > 0 { seed(x, y - 1) }; if y < h - 1 { seed(x, y + 1) } }
var res = px
for i in 0..<(w * h) { if out[i] { res[i * 4 + 3] = 0; res[i * 4] = 0; res[i * 4 + 1] = 0; res[i * 4 + 2] = 0 } }
// 1px feather: opaque pixels touching a transparent one get half alpha
for y in 1..<(h - 1) { for x in 1..<(w - 1) { let i = y * w + x; if !out[i] && (out[i - 1] || out[i + 1] || out[i - w] || out[i + w]) { res[i * 4 + 3] = 140 } } }
let removed = out.filter { $0 }.count; print("transparent pixels: \(removed) of \(w * h) (\(100 * removed / (w * h))%)")
let provider = CGDataProvider(data: Data(res) as CFData)!
let outImg = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: cs, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
let rep = NSBitmapImageRep(cgImage: outImg); try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
