// HQ in a web view: its microphone granted, signed in with a one-time code, and its calls' audio handed to CallAudio.
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
    web.isInspectable = true  // (Safari's Develop menu on a Mac shows the page's console)
    web.load(URLRequest(url: Self.home))
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}
}

@MainActor
final class Bridge: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
  let call = CallAudio()

  // The page's word on its call (callaudio.js): {call: true} as it starts, {call: false} as it ends.
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.securityOrigin.host == ShellView.home.host,
      let body = message.body as? [String: Any], let live = body["call"] as? Bool
    else { return }
    if live { call.start() } else { call.end() }
  }

  // HQ's own pages get the microphone without the web view asking at every call.
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    decisionHandler(origin.host == ShellView.home.host ? .grant : .prompt)
  }

  // A passkey works in an app only when Apple ties the app to HQ's domain, which takes a paid developer account. So
  // the sign-in page gives way to HQ's one-time code from a device already signed in (/pair).
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = action.request.url
    guard action.targetFrame?.isMainFrame == true, url?.host == ShellView.home.host, url?.path == "/login" else {
      return decisionHandler(.allow)
    }
    decisionHandler(.cancel)
    webView.load(URLRequest(url: URL(string: "/pair", relativeTo: ShellView.home)!.absoluteURL))
  }

  // A new page, or the page's process lost, has no call: one still on ends with the old page.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    call.end()
  }

  // A page that doesn't load at the network (no signal, HQ not answering) leaves WKWebView blank: this page says so,
  // and its Try again opens HQ again.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(webView, error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(webView, error)
  }

  // (a cancel is a navigation giving way to another, like /login's to /pair; WebKit's own errors aren't the network)
  private func failed(_ webView: WKWebView, _ error: Error) {
    guard let failure = error as? URLError, failure.code != .cancelled else { return }
    let address = ShellView.home.absoluteString
    let page = """
      <!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <body style="margin: 0; min-height: 100vh; display: grid; place-content: center; padding: 0 24px;
        font: 17px -apple-system, sans-serif; text-align: center">
      <p>HQ didn't load from \(address).</p>
      <p>\(failure.localizedDescription)</p>
      <p><a href="\(address)" style="display: inline-block; padding: 12px 24px; border-radius: 12px;
        background: #007aff; color: #fff; text-decoration: none">Try again</a></p>
      """
    webView.loadHTMLString(page, baseURL: nil)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    call.end()
    webView.reload()
  }

  // A link that opens a new window opens in the browser.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { UIApplication.shared.open(url) }
    return nil
  }
}
