---
name: Agent Bridge
colors:
  canvas: "#111c24"
  surface: "#1b2a34"
  rail: "#172630"
  text: "#edf4f5"
  muted-text: "#abc0ca"
  accent: "#19697c"
  action-text: "#91d9df"
  on-accent: "#ffffff"
  focus: "#85d2e0"
  border: "#3c505c"
  control-border: "#718b95"
  error: "#f08080"
  warning: "#f0c36a"
  warning-surface: "#2a2416"
  success: "#7bc47f"
  success-surface: "#1f2a22"
  masthead: "#102b36"
  masthead-text: "#eaf5f6"
  own-message: "#173945"
  link: "#5aa7e0"
  accent-hover: "#20788b"
  field: "#243540"
  code: "#0c171e"
  brand: "#83d6cf"
  primary: "#2f5d3a"
  warning-tray: "#221d12"
  alert: "#ff9c7a"
  warning-border: "#8a6d2f"
  success-border: "#3d7a4b"
  danger-soft: "#f3a3a3"
  danger-border: "#7a3d3d"
  agent-1: "#f0a37d"
  agent-2: "#75bafa"
  agent-3: "#c79cf4"
  agent-4: "#76c9a2"
  agent-5: "#e5bf63"
  agent-6: "#f598bb"
  agent-7: "#73cbd4"
  agent-8: "#bdcf79"
themes:
  light:
    colors:
      canvas: "#f0f4f5"
      surface: "#ffffff"
      rail: "#f8faf9"
      text: "#172d37"
      muted-text: "#4e666e"
      accent: "#155b70"
      action-text: "#155b70"
      on-accent: "#ffffff"
      focus: "#08647b"
      border: "#cedadc"
      control-border: "#71878c"
      error: "#c62828"
      warning: "#8a5a00"
      warning-surface: "#fff6df"
      success: "#2e7d32"
      success-surface: "#eaf6ec"
      masthead: "#102b36"
      masthead-text: "#eaf5f6"
      own-message: "#e0f0f2"
      link: "#215e98"
      accent-hover: "#104b5e"
      field: "#eaf0f1"
      code: "#e9eff0"
      brand: "#83d6cf"
      primary: "#2e7d32"
      warning-tray: "#fff9ec"
      alert: "#b3471f"
      warning-border: "#e3c27a"
      success-border: "#9bd1a1"
      danger-soft: "#c62828"
      danger-border: "#e8a3a3"
      agent-1: "#8d431a"
      agent-2: "#215e98"
      agent-3: "#66399a"
      agent-4: "#216946"
      agent-5: "#735410"
      agent-6: "#98345f"
      agent-7: "#20676f"
      agent-8: "#53671c"
effects:
  backdrop: "rgb(9 26 34 / 0.62)"
  dark-shadow: "rgb(0 0 0 / 0.45)"
  light-shadow: "rgb(0 0 0 / 0.18)"
typography:
  caption:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  subheading:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  title:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
  display:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
rounded:
  none: "0"
  small: "4px"
  control: "6px"
  panel: "10px"
  dialog: "14px"
  pill: "999px"
---

# Agent Bridge

- Product and audience (assumed) — a local workspace for people coordinating coding agents. The conversation and message composer occupy the main column.
- Density (assumed) — compact controls, an adjustable team rail and a fluid transcript accommodate long coding sessions.
- Brand (assumed) — a marine header identifies the workspace in both themes. The header and browser tab share the Windows app icon in [public/favicon.ico](public/favicon.ico). Teal marks actions. Individual agent colors remain attached to their identities.

## Interaction

Keep agents on the left and the user's messages on the right. Place the recipient before the message and the send button after it. At phone widths the recipient moves above the message. Keep status text alongside any colored indicator. Use system fonts for controls and a monospace face for code and usage figures.

## Contrast

The default palette is dark. Light follows the system preference. The CSS tokens are in [tokens.css](public/css/tokens.css).

| Foreground | Background | Theme/state | Ratio | Minimum |
| --- | --- | --- | --- | --- |
| text | canvas | default | 15.52:1 | 4.5:1 |
| text | surface | default | 13.21:1 | 4.5:1 |
| text | own-message | default | 11.04:1 | 4.5:1 |
| text | field | default | 11.37:1 | 4.5:1 |
| muted-text | canvas | default | 9.15:1 | 4.5:1 |
| muted-text | surface | default | 7.79:1 | 4.5:1 |
| muted-text | rail | default | 8.20:1 | 4.5:1 |
| action-text | surface | default | 9.24:1 | 4.5:1 |
| on-accent | accent | default | 6.26:1 | 4.5:1 |
| on-accent | accent-hover | default | 5.10:1 | 4.5:1 |
| masthead-text | masthead | default | 13.29:1 | 4.5:1 |
| warning | warning-surface | default | 9.34:1 | 4.5:1 |
| success | success-surface | default | 7.11:1 | 4.5:1 |
| error | surface | default | 5.68:1 | 4.5:1 |
| link | canvas | default | 6.61:1 | 4.5:1 |
| focus | canvas | default | 10.11:1 | 3:1 |
| control-border | field | default | 3.52:1 | 3:1 |
| text | canvas | light | 12.93:1 | 4.5:1 |
| text | surface | light | 14.32:1 | 4.5:1 |
| text | own-message | light | 12.21:1 | 4.5:1 |
| text | field | light | 12.43:1 | 4.5:1 |
| muted-text | canvas | light | 5.50:1 | 4.5:1 |
| muted-text | surface | light | 6.09:1 | 4.5:1 |
| muted-text | rail | light | 5.81:1 | 4.5:1 |
| action-text | surface | light | 7.60:1 | 4.5:1 |
| on-accent | accent | light | 7.60:1 | 4.5:1 |
| on-accent | accent-hover | light | 9.59:1 | 4.5:1 |
| masthead-text | masthead | light | 13.29:1 | 4.5:1 |
| warning | warning-surface | light | 5.50:1 | 4.5:1 |
| success | success-surface | light | 4.61:1 | 4.5:1 |
| error | surface | light | 5.62:1 | 4.5:1 |
| link | canvas | light | 6.08:1 | 4.5:1 |
| focus | canvas | light | 6.08:1 | 3:1 |
| control-border | field | light | 3.29:1 | 3:1 |
