# Operator Dock Design

This directory contains design source material and implementation notes for the Operator Dock macOS app.

## Claude Handoff

`docs/design/claude-handoff` contains the original Claude design handoff package. Treat it as the visual source of truth for Phase 1:

- `tokens.json` and `tokens.css` define the design tokens.
- `figma-spec.md`, `component-specs.md`, and `screen-specs.md` describe layout, components, states, and screen anatomy.
- `refs/*.jsx` contains read-only React references for translating the design into SwiftUI.

The handoff still uses the exploration name "Handle" in places. Operator Dock should preserve the visual intent while using Operator Dock naming in product UI and code.

