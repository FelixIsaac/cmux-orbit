// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "CmuxNative",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "CmuxCore", targets: ["CmuxCore"]),
        .executable(name: "cmux-orbit-mac", targets: ["CmuxOrbitMac"]),
        .library(name: "CmuxOrbitIOS", targets: ["CmuxOrbitIOS"]),
    ],
    targets: [
        .target(
            name: "CmuxCore",
            dependencies: [],
            path: "Sources/CmuxCore"
        ),
        .executableTarget(
            name: "CmuxOrbitMac",
            dependencies: ["CmuxCore"],
            path: "Sources/CmuxOrbitMac"
        ),
        .target(
            name: "CmuxOrbitIOS",
            dependencies: ["CmuxCore"],
            path: "Sources/CmuxOrbitIOS"
        ),
    ]
)
