// HQ in a web view: its microphone granted, signed in through Apple's sign-in sheet, its calls' audio handed to
// CallAudio and the notebook's Pencil drawn by Pen.
import AuthenticationServices
import CryptoKit
import SwiftUI
import WebKit

struct ShellView: UIViewRepresentable {
  // (Info.plist's HQURL, set by the company's theme/ios.xcconfig)
  static let home: URL = {
    guard let address = Bundle.main.object(forInfoDictionaryKey: "HQURL") as? String,
      let home = URL(string: address), home.host != nil
    else { fatalError("HQ_URL in theme/ios.xcconfig isn't an address: an .xcconfig writes // as /$()/") }
    return home
  }()

  func makeCoordinator() -> Bridge { Bridge() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    // (a call's voice plays from an <audio> element the page starts again after a stall, outside a tap too)
    config.mediaTypesRequiringUserActionForPlayback = []
    config.userContentController.add(context.coordinator, name: "shell")
    let web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = context.coordinator
    web.navigationDelegate = context.coordinator
    web.scrollView.contentInsetAdjustmentBehavior = .never
    #if DEBUG
      web.isInspectable = true  // (Safari's Develop menu on a Mac shows the page's console)
    #endif
    context.coordinator.pen = Pen(over: web)
    web.load(URLRequest(url: Self.home))
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}
}

@MainActor
final class Bridge: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate,
  ASWebAuthenticationPresentationContextProviding
{
  let call = CallAudio()
  var pen: Pen!
  private var sheet: ASWebAuthenticationSession?   // (Apple's sign-in sheet, while it's open)
  private weak var window: UIWindow?   // (the window of the web view that asked for it, where it opens)

  // The page's word on its call (callaudio.js): {call: true} as it starts, {call: false} as it ends; and on its pen
  // (booknative.js): {pen: {paper, tool, color, size, alpha}} while the notebook's Pencil is the shell's, {pen: false}.
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.securityOrigin.host == ShellView.home.host, let body = message.body as? [String: Any]
    else { return }
    if let live = body["call"] as? Bool {
      if live { call.start() } else { call.end() }
    }
    // (false: the Pencil the page's)
    if let said = body["pen"] { pen.set(said as? [String: Any]) }
  }

  // HQ's own pages get the microphone without the web view asking at every call.
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    decisionHandler(origin.host == ShellView.home.host ? .grant : .prompt)
  }

  // A passkey works in a web view only when Apple ties the app to HQ's domain, which takes a paid developer account. So
  // the sign-in page gives way to Apple's sign-in sheet (signIn below). Another site's page opens in the browser: the
  // shell, with its microphone and its messages, is HQ's alone.
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = action.request.url
    if action.targetFrame?.isMainFrame == true, let url, url.host != ShellView.home.host, Self.web(url) {
      decisionHandler(.cancel)
      UIApplication.shared.open(url)
      return
    }
    guard action.targetFrame?.isMainFrame == true, url?.host == ShellView.home.host, url?.path == "/login" else {
      return decisionHandler(.allow)
    }
    decisionHandler(.cancel)
    signIn(webView)
  }

  // HQ's sign-in page in Apple's sheet, a browser of its own where the passkey works, asked for the app
  // (/login?app=…): its unlock gives the sheet a one-time code, which the web view trades for its session with the
  // verifier only this app holds (the coordinator's auth.ts createAppCode). Nothing of the sheet's is kept (ephemeral).
  private func signIn(_ webView: WKWebView) {
    guard sheet == nil else { return }
    let verifier = Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URL
    let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
    let page = Self.address("/login", ["app": challenge])
    let sheet = ASWebAuthenticationSession(url: page, callbackURLScheme: "hq-shell") { [weak self, weak webView] back, _ in
      let code = back.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
        .queryItems?.first { $0.name == "code" }?.value
      Task { @MainActor in
        self?.sheet = nil
        guard let webView else { return }
        guard let code else { return Self.signedOut(webView) }
        webView.load(URLRequest(url: Self.address("/app/signed-in", ["code": code, "verifier": verifier])))
      }
    }
    window = webView.window
    sheet.presentationContextProvider = self
    sheet.prefersEphemeralWebBrowserSession = true
    self.sheet = sheet
    if !sheet.start() {
      self.sheet = nil
      Self.signedOut(webView)
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { window! }
  }

  private static func address(_ path: String, _ query: [String: String]) -> URL {
    var parts = URLComponents(url: URL(string: path, relativeTo: ShellView.home)!, resolvingAgainstBaseURL: true)!
    parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
    return parts.url!
  }

  // The sheet closed without signing in: a page that says so, whose button opens the sheet again
  private static func signedOut(_ webView: WKWebView) {
    page(webView, ["Not signed in to HQ."], "Sign in")
  }

  // A new page, or the page's process lost, has no call and no notebook: the old page's end with it.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    call.end()
    pen.set(nil)
  }

  // A page that doesn't load at the network (no signal, HQ not answering) leaves WKWebView blank: this page says so,
  // and its Try again opens HQ again.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(webView, error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(webView, error)
  }

  // (a cancel is a navigation giving way to another, like /login's to the sign-in sheet; WebKit's own errors aren't the
  // network)
  private func failed(_ webView: WKWebView, _ error: Error) {
    guard let failure = error as? URLError, failure.code != .cancelled else { return }
    Self.page(webView, ["HQ didn't load from \(ShellView.home.absoluteString).", failure.localizedDescription], "Try again")
  }

  // A page of the app's own, its button opening HQ again
  private static func page(_ webView: WKWebView, _ paragraphs: [String], _ button: String) {
    let address = ShellView.home.absoluteString
    let page = """
      <!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <body style="margin: 0; min-height: 100vh; display: grid; place-content: center; padding: 0 24px;
        font: 17px -apple-system, sans-serif; text-align: center">
      \(paragraphs.map { "<p>\($0)</p>" }.joined())
      <p><a href="\(address)" style="display: inline-block; padding: 12px 24px; border-radius: 12px;
        background: #007aff; color: #fff; text-decoration: none">\(button)</a></p>
      """
    webView.loadHTMLString(page, baseURL: nil)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    call.end()
    pen.set(nil)
    webView.reload()
  }

  // A link that opens a new window opens in the browser, a web page's only (no other app's scheme).
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url, Self.web(url) { UIApplication.shared.open(url) }
    return nil
  }

  private static func web(_ url: URL) -> Bool { ["http", "https"].contains(url.scheme?.lowercased()) }
}

extension Data {
  // (base64url without padding, as the coordinator reads a challenge)
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
