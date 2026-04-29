// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "OperatorDockHelper",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .library(
      name: "OperatorDockPersistence",
      targets: ["OperatorDockPersistence"]
    ),
    .executable(
      name: "OperatorDockHelper",
      targets: ["OperatorDockHelper"]
    )
  ],
  targets: [
    .target(
      name: "OperatorDockPersistence",
      swiftSettings: [
        .enableExperimentalFeature("StrictConcurrency")
      ]
    ),
    .executableTarget(
      name: "OperatorDockHelper",
      dependencies: ["OperatorDockPersistence"]
    ),
    .testTarget(
      name: "OperatorDockPersistenceTests",
      dependencies: ["OperatorDockPersistence"]
    )
  ]
)
