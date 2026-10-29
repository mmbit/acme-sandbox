// A call's audio with the screen off or the phone at the ear (README.md, Calls with the screen off).
import AVFoundation
import UIKit
import os

@MainActor
final class CallAudio {
  private var live = false
  private var watchers: [NSObjectProtocol] = []
  private let log = Logger(subsystem: "HQ", category: "call audio")
  // (the session as it was before the call, given back as it ends: WebKit's own, for the page's other sounds)
  private var before: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

  func start() {
    guard !live else { return }
    live = true
    let session = AVAudioSession.sharedInstance()
    before = (session.category, session.mode, session.categoryOptions)
    UIDevice.current.isProximityMonitoringEnabled = true  // (stays off on an iPad, which has no sensor)
    let center = NotificationCenter.default
    let changes = [
      UIDevice.proximityStateDidChangeNotification, AVAudioSession.routeChangeNotification,
      UIApplication.didEnterBackgroundNotification, UIApplication.didBecomeActiveNotification,
    ]
    watchers = changes.map { name in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.route() }
      }
    }
    route()
  }

  func end() {
    guard live else { return }
    live = false
    for watcher in watchers { NotificationCenter.default.removeObserver(watcher) }
    watchers = []
    UIDevice.current.isProximityMonitoringEnabled = false
    let session = AVAudioSession.sharedInstance()
    set("the end of the override") { try session.overrideOutputAudioPort(.none) }
    if let before {
      set("the session before the call") {
        try session.setCategory(before.category, mode: before.mode, options: before.options)
      }
    }
  }

  // WebKit sets the session's category itself as the page's microphone and sound start, and each change of category
  // is a change of route: so the session is set again on every one that isn't ours. Without defaultToSpeaker, a voice
  // chat plays from the earpiece, and the speaker is an override.
  private func route() {
    let session = AVAudioSession.sharedInstance()
    let ours = session.category == .playAndRecord && session.mode == .voiceChat
    if !ours || session.categoryOptions.contains(.defaultToSpeaker) {
      set("the voice chat session") {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
      }
    }
    let atEar = UIDevice.current.proximityState || UIApplication.shared.applicationState == .background
    let outputs = session.currentRoute.outputs.map(\.portType)
    let onPhone = outputs.allSatisfy { $0 == .builtInReceiver || $0 == .builtInSpeaker }
    let toSpeaker = onPhone && !atEar
    let onSpeaker = outputs == [.builtInSpeaker]
    // (only when it changes: an override is itself a change of route)
    if toSpeaker != onSpeaker {
      set(toSpeaker ? "the speaker" : "the earpiece") {
        try session.overrideOutputAudioPort(toSpeaker ? .speaker : .none)
      }
    }
  }

  // A setting iOS turns down (another app's or a phone call's session) leaves the call where it's heard now: said in
  // the device's log, and tried again at the next change of route.
  private func set(_ what: String, _ change: () throws -> Void) {
    do {
      try change()
    } catch {
      log.error("\(what, privacy: .public) failed: \(String(describing: error), privacy: .public)")
    }
  }
}
