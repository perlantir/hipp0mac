// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "OperatorDock",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .executable(
      name: "OperatorDock",
      targets: ["OperatorDock"]
    ),
    .library(
      name: "OperatorDockCore",
      targets: ["OperatorDockCore"]
    )
  ],
  targets: [
    .executableTarget(
      name: "OperatorDock",
      dependencies: ["OperatorDockCore"]
    ),
    .target(
      name: "OperatorDockCore",
      linkerSettings: [
        .linkedFramework("Security")
      ]
    ),
    .testTarget(
      name: "OperatorDockCoreTests",
      dependencies: [
        "OperatorDockCore",
        "OperatorDock"
      ]
    )
  ]
)
