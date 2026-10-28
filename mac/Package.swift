// swift-tools-version:5.10
//
// Grove for Mac. Built with the command-line tools alone — no Xcode project —
// by build.sh, which compiles this package and wraps the binary in an app
// bundle with the Info.plist beside this file.

import PackageDescription

let package = Package(
  name: "Grove",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "Grove",
      path: "Sources/Grove",
      resources: [.copy("Resources/panel.html")]
    ),
  ]
)
