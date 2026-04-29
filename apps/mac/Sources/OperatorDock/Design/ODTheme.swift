import SwiftUI

enum ODTheme {
  enum ColorToken {
    static let canvas = Color(hex: 0x101114)
    static let sidebar = Color(hex: 0x15161A)
    static let surface = Color(hex: 0x1B1D22)
    static let surfaceRaised = Color(hex: 0x22252B)
    static let subtle = Color(hex: 0x2A2D34)
    static let muted = Color(hex: 0x343842)
    static let border = Color.white.opacity(0.075)
    static let borderStrong = Color.white.opacity(0.14)
    static let textPrimary = Color(hex: 0xF6F3EA)
    static let textSecondary = Color(hex: 0xB8B4AA)
    static let textTertiary = Color(hex: 0x858A94)
    static let textMuted = Color(hex: 0x5F6570)
    static let accent = Color(hex: 0x5D8DFF)
    static let accentSoft = Color(hex: 0x203356)
    static let success = Color(hex: 0x45C078)
    static let waiting = Color(hex: 0xD9A23B)
    static let error = Color(hex: 0xE35B4F)
    static let browser = Color(hex: 0x39A6C8)
    static let memory = Color(hex: 0xC174D4)
    static let tool = Color(hex: 0x9380D6)
  }

  enum Radius {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 6
    static let md: CGFloat = 8
    static let lg: CGFloat = 10
    static let xl: CGFloat = 12
    static let card: CGFloat = 14
    static let modal: CGFloat = 18
  }

  enum Space {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let page: CGFloat = 32
  }
}

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: opacity
    )
  }
}

extension Font {
  static func odDisplay(_ size: CGFloat, weight: Weight = .medium) -> Font {
    .system(size: size, weight: weight, design: .default)
  }

  static func odText(_ size: CGFloat, weight: Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .default)
  }

  static func odMono(_ size: CGFloat, weight: Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }
}

struct ODCardBackground: ViewModifier {
  var radius: CGFloat = ODTheme.Radius.card
  var fill: Color = ODTheme.ColorToken.surface

  func body(content: Content) -> some View {
    content
      .background(fill)
      .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .stroke(ODTheme.ColorToken.border, lineWidth: 1)
      )
  }
}

extension View {
  func odCard(radius: CGFloat = ODTheme.Radius.card, fill: Color = ODTheme.ColorToken.surface) -> some View {
    modifier(ODCardBackground(radius: radius, fill: fill))
  }
}

