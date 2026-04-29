import SwiftUI

struct SchedulesScreen: View {
  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Schedules",
        subtitle: "Recurring autonomous runs, windows, and upcoming work."
      ) {
        PillButton(title: "New schedule", systemImage: "calendar.badge.plus", style: .primary) {}
      }

      VStack(alignment: .leading, spacing: 18) {
        SectionLabel(title: "Today")
        TimelineStrip()

        SectionLabel(title: "All schedules")
        VStack(spacing: 0) {
          ForEach(SampleData.schedules) { schedule in
            HStack(spacing: 12) {
              Circle()
                .fill(schedule.enabled ? ODTheme.ColorToken.success : ODTheme.ColorToken.textMuted)
                .frame(width: 8, height: 8)

              VStack(alignment: .leading, spacing: 3) {
                Text(schedule.name)
                  .font(.odText(13, weight: .medium))
                  .foregroundStyle(ODTheme.ColorToken.textPrimary)
                Text(schedule.cron)
                  .font(.odMono(11))
                  .foregroundStyle(ODTheme.ColorToken.textTertiary)
              }

              Spacer()

              Text(schedule.lastRun)
                .frame(width: 120, alignment: .leading)
              Text(schedule.nextRun)
                .frame(width: 130, alignment: .leading)
              Text(schedule.enabled ? "On" : "Off")
                .foregroundStyle(schedule.enabled ? ODTheme.ColorToken.success : ODTheme.ColorToken.textMuted)
                .frame(width: 44, alignment: .leading)
              Image(systemName: "ellipsis")
                .foregroundStyle(ODTheme.ColorToken.textMuted)
            }
            .font(.odText(12))
            .foregroundStyle(ODTheme.ColorToken.textSecondary)
            .padding(.horizontal, 16)
            .frame(height: 58)
          }
        }
        .odCard()
      }
      .padding(.horizontal, ODTheme.Space.page)

      Spacer()
    }
    .background(ODTheme.ColorToken.canvas)
  }
}

private struct TimelineStrip: View {
  var body: some View {
    ZStack(alignment: .leading) {
      RoundedRectangle(cornerRadius: ODTheme.Radius.card, style: .continuous)
        .fill(ODTheme.ColorToken.surface)
        .overlay(RoundedRectangle(cornerRadius: ODTheme.Radius.card, style: .continuous).stroke(ODTheme.ColorToken.border, lineWidth: 1))

      HStack(spacing: 0) {
        ForEach(0..<24, id: \.self) { hour in
          VStack {
            Text(hour % 6 == 0 ? "\(hour)" : "")
              .font(.odMono(10))
              .foregroundStyle(ODTheme.ColorToken.textMuted)
            Spacer()
          }
          .frame(maxWidth: .infinity)
        }
      }
      .padding(14)

      SchedulePill(title: "Digest", x: 0.32)
      SchedulePill(title: "Sweep", x: 0.58)
      Rectangle()
        .fill(ODTheme.ColorToken.accent)
        .frame(width: 1)
        .padding(.vertical, 12)
        .offset(x: 410)
    }
    .frame(height: 104)
  }
}

private struct SchedulePill: View {
  let title: String
  let x: CGFloat

  var body: some View {
    Text(title)
      .font(.odText(11.5, weight: .medium))
      .foregroundStyle(ODTheme.ColorToken.textPrimary)
      .padding(.horizontal, 10)
      .frame(height: 26)
      .background(ODTheme.ColorToken.accentSoft)
      .clipShape(Capsule())
      .offset(x: x * 760, y: 18)
  }
}

