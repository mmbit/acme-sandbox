// The native shell: HQ's web app in a web view, with what only an app can do added through a bridge (README.md).
import SwiftUI

@main
struct ShellApp: App {
  var body: some Scene {
    WindowGroup {
      // (HQ's page fits itself around the notch and the home bar: viewport-fit=cover)
      ShellView().ignoresSafeArea()
    }
  }
}
