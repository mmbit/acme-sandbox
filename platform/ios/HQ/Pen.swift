// The Apple Pencil drawn by PencilKit over the notebook's paper (README.md, The pen): Apple's own ink, as quick as
// Notes', handed to the page stroke by stroke (shell/ink/booknative.js), which takes each as if drawn on it.
import PencilKit
import UIKit
import UIKit.UIGestureRecognizerSubclass
import WebKit
import os

@MainActor
final class Pen: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
  // (a Pencil's full press, as WebKit's pressure 1: UITouch's maximumPossibleForce)
  private static let fullForce: CGFloat = 4.17
  // (how long the shell's line takes to give way to the page's)
  private static let fadeSeconds = 0.12
  // the page's tools whose line the canvas draws, as PencilKit's inks
  private static let inks: [String: PKInkingTool.InkType] = ["pen": .pen, "highlighter": .marker]

  private weak var web: WKWebView?
  private let canvas = PKCanvasView()
  private let gate = PaperGate()
  private let log = Logger(subsystem: "HQ", category: "pen")
  // the strokes on the canvas handed to the page, by their number (the oldest first), and of them, those the page has
  // painted
  private var handed: [Int] = []
  private var painted: Set<Int> = []
  private var numbered = 0
  private var drawing = false

  // PencilKit's own gesture moves onto the web view, so a finger never meets the canvas and goes to the page as it
  // would: the canvas only shows the ink. Its gesture takes the Pencil only where the gate lets it, on the paper.
  init(over web: WKWebView) {
    self.web = web
    super.init()
    canvas.backgroundColor = .clear
    canvas.isOpaque = false
    canvas.drawingPolicy = .pencilOnly
    canvas.isUserInteractionEnabled = false
    canvas.clipsToBounds = true
    canvas.delegate = self
    web.addSubview(canvas)
    let pencil = canvas.drawingGestureRecognizer
    web.addGestureRecognizer(pencil)
    gate.allowedTouchTypes = [UITouch.TouchType.pencil.rawValue as NSNumber]
    gate.cancelsTouchesInView = false
    gate.delaysTouchesEnded = false
    gate.delegate = self
    web.addGestureRecognizer(gate)
    pencil.require(toFail: gate)
    // (a Pencil's touch on the paper never reaches the page as well: the stroke comes to it whole, once drawn)
    pencil.delaysTouchesBegan = true
    set(nil)
  }

  // The page's word on its pen (booknative.js): the paper's rectangle in its px, the tool, the ink's colour, width
  // and alpha, all of them always there; nil when the Pencil is the page's (another tool, the book folded, another
  // page).
  func set(_ pen: [String: Any]?) {
    guard let pen else {
      canvas.drawingGestureRecognizer.isEnabled = false
      gate.isEnabled = false
      // (clear the ink left, unacknowledged strokes too, so it can't cover another page or tool)
      canvas.drawing = PKDrawing()
      handed = []
      painted = []
      return
    }
    let paper = pen["paper"] as! [Double]
    let rect = CGRect(x: paper[0], y: paper[1], width: paper[2], height: paper[3])
    if canvas.frame != rect {
      canvas.frame = rect
      gate.paper = rect
    }
    let color = Self.color(pen["color"] as! String).withAlphaComponent(pen["alpha"] as! Double)
    canvas.tool = PKInkingTool(Self.inks[pen["tool"] as! String]!, color: color, width: pen["size"] as! Double)
    canvas.drawingGestureRecognizer.isEnabled = true
    gate.isEnabled = true
  }

  // A stroke finished: to the page in its px ([x, y, pressure, ms from its first point]), and once the page has
  // painted it, the canvas's own line goes.
  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    let strokes = canvas.drawing.strokes
    guard strokes.count > handed.count else { return }
    for stroke in strokes[handed.count...] {
      numbered += 1
      handed.append(numbered)
      hand(stroke, numbered)
    }
  }

  func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
    drawing = true
  }

  // (dried once the stroke just lifted is in the drawing: its change may come after this)
  func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
    drawing = false
    Task { @MainActor [weak self] in self?.dry() }
  }

  // (a stroke the page didn't take stays on the canvas, said in the device's log: what of it the page has is unknown,
  // so it isn't handed again)
  private func hand(_ stroke: PKStroke, _ number: Int) {
    let at = canvas.frame.origin
    let points = stroke.path.interpolatedPoints(by: .distance(2)).map { point -> [Double] in
      let p = point.location.applying(stroke.transform)
      return [
        Self.round(p.x + at.x), Self.round(p.y + at.y), Self.round(min(1, point.force / Self.fullForce)),
        (point.timeOffset * 1000).rounded(),
      ]
    }
    web?.callAsyncJavaScript(
      "return await window.shellPen(points)", arguments: ["points": points], in: nil, in: .page
    ) { [weak self] result in
      MainActor.assumeIsolated {
        guard let self else { return }
        switch result {
        case .success:
          self.painted.insert(number)
          self.dry()
        case .failure(let error):
          self.log.error("the page didn't take a stroke: \(String(describing: error), privacy: .public)")
        }
      }
    }
  }

  // The strokes the page has painted, off the canvas: faded out over the page's own, and never mid-stroke (a new
  // drawing set then would lose the line under the Pencil).
  private func dry() {
    guard !drawing, !painted.isEmpty else { return }
    let strokes = canvas.drawing.strokes
    let dried = handed.map(painted.contains)
    fade(zip(strokes, dried).filter { $0.1 }.map(\.0))
    canvas.drawing = PKDrawing(strokes: zip(strokes, dried).filter { !$0.1 }.map(\.0) + strokes[handed.count...])
    handed.removeAll(where: painted.contains)
    painted = []
  }

  private func fade(_ strokes: [PKStroke]) {
    let drawn = PKDrawing(strokes: strokes)
    let box = drawn.bounds.intersection(canvas.bounds)
    guard let web, !box.isEmpty else { return }
    let ink = UIImageView(image: drawn.image(from: box, scale: canvas.traitCollection.displayScale))
    ink.frame = box.offsetBy(dx: canvas.frame.minX, dy: canvas.frame.minY)
    web.insertSubview(ink, aboveSubview: canvas)
    UIView.animate(withDuration: Self.fadeSeconds, animations: { ink.alpha = 0 }) { _ in ink.removeFromSuperview() }
  }

  // (the gate holds its own Pencil touch alongside the page's: a tap on a button beside the paper still presses it)
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }

  private static func round(_ n: CGFloat) -> Double { (Double(n) * 100).rounded() / 100 }

  // "#rrggbb", the page's inks' way (shared/review/ink.js)
  private static func color(_ hex: String) -> UIColor {
    let rgb = Int(hex.dropFirst(), radix: 16)!
    return UIColor(
      red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255,
      blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
  }
}

// The Pencil off the paper (the tools, HQ's page beside the book) is the page's: the gate takes such a touch at once,
// which fails PencilKit's gesture for it. On the paper the gate fails at once, and PencilKit draws.
private final class PaperGate: UIGestureRecognizer {
  var paper = CGRect.null

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let view, let touch = touches.first, state == .possible else { return }
    state = paper.contains(touch.location(in: view)) ? .failed : .began
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    state = state == .began ? .ended : .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    state = state == .began ? .cancelled : .failed
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
