import SwiftUI

struct MemoryScreen: View {
  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Memory",
        subtitle: "Curated facts, preferences, policies, and project context."
      ) {
        PillButton(title: "Review queue", systemImage: "tray", style: .secondary) {}
      }

      HStack(alignment: .top, spacing: 12) {
        facets
          .frame(width: 220)

        graph
          .frame(maxWidth: .infinity, minHeight: 520)

        detail
          .frame(width: 320)
      }
      .padding(.horizontal, ODTheme.Space.page)

      Spacer()
    }
    .background(ODTheme.ColorToken.canvas)
  }

  private var facets: some View {
    VStack(alignment: .leading, spacing: 16) {
      SectionLabel(title: "Kind")
      FacetRow(color: ODTheme.ColorToken.memory, title: "Preference", count: 38)
      FacetRow(color: ODTheme.ColorToken.accent, title: "Project", count: 24)
      FacetRow(color: ODTheme.ColorToken.success, title: "Policy", count: 12)

      Divider().overlay(ODTheme.ColorToken.border)

      SectionLabel(title: "Source")
      FacetRow(color: ODTheme.ColorToken.tool, title: "Workspace", count: 44)
      FacetRow(color: ODTheme.ColorToken.browser, title: "Notion", count: 17)
      FacetRow(color: ODTheme.ColorToken.waiting, title: "Approval history", count: 8)
    }
    .padding(16)
    .odCard()
  }

  private var graph: some View {
    ZStack {
      RoundedRectangle(cornerRadius: ODTheme.Radius.card, style: .continuous)
        .fill(ODTheme.ColorToken.surface)
        .overlay(RoundedRectangle(cornerRadius: ODTheme.Radius.card, style: .continuous).stroke(ODTheme.ColorToken.border, lineWidth: 1))

      Canvas { context, size in
        let points = [
          CGPoint(x: size.width * 0.50, y: size.height * 0.45),
          CGPoint(x: size.width * 0.28, y: size.height * 0.28),
          CGPoint(x: size.width * 0.70, y: size.height * 0.30),
          CGPoint(x: size.width * 0.32, y: size.height * 0.68),
          CGPoint(x: size.width * 0.68, y: size.height * 0.66)
        ]

        var path = Path()
        for point in points.dropFirst() {
          path.move(to: points[0])
          path.addLine(to: point)
        }
        context.stroke(path, with: .color(ODTheme.ColorToken.borderStrong), lineWidth: 1)

        for (index, point) in points.enumerated() {
          let radius: CGFloat = index == 0 ? 34 : 24
          let rect = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
          context.fill(Path(ellipseIn: rect), with: .color(index == 0 ? ODTheme.ColorToken.accent : ODTheme.ColorToken.memory))
        }
      }

      Text("Rae")
        .font(.odText(13, weight: .semibold))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
    }
  }

  private var detail: some View {
    VStack(alignment: .leading, spacing: 16) {
      SectionLabel(title: "Entity detail")

      VStack(alignment: .leading, spacing: 10) {
        Text("Project · Operator Dock")
          .font(.odText(13, weight: .semibold))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text("Key facts")
          .font(.odText(11, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textMuted)
          .textCase(.uppercase)

        ForEach(SampleData.memory) { record in
          MemoryRecordRow(record: record)
        }
      }
      .padding(16)
      .odCard()
    }
  }
}

private struct FacetRow: View {
  let color: Color
  let title: String
  let count: Int

  var body: some View {
    HStack {
      RoundedRectangle(cornerRadius: 3, style: .continuous)
        .fill(color)
        .frame(width: 10, height: 10)

      Text(title)
        .font(.odText(12))
        .foregroundStyle(ODTheme.ColorToken.textSecondary)

      Spacer()

      Text("\(count)")
        .font(.odMono(11))
        .foregroundStyle(ODTheme.ColorToken.textMuted)
    }
  }
}

