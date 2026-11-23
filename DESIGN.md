---
name: Agent Bridge
colors:
  canvas: "#161719"
  surface: "#242426"
  rail: "#303033"
  text: "#f4efe9"
  muted-text: "#c0b9b2"
  accent: "#e4a476"
  action-text: "#99ccd8"
  on-accent: "#251910"
  focus: "#aedcea"
  border: "#4b494b"
  control-border: "#8c8784"
  error: "#ff9a9d"
  warning: "#f1cf82"
  warning-surface: "#3b3120"
  success: "#96cca2"
  success-surface: "#20362a"
  masthead: "#101113"
  masthead-text: "#f4efe9"
  own-message: "#253d44"
  link: "#9ed4e4"
  accent-hover: "#f0b78c"
  field: "#39383b"
  code: "#19191b"
  brand: "#9ed6e0"
  primary: "#e4a476"
  warning-tray: "#2d281f"
  alert: "#f6b4a8"
  warning-border: "#96783f"
  success-border: "#648b6b"
  danger-soft: "#ffc1c0"
  danger-border: "#9c6067"
  agent-1: "#ecc49b"
  agent-2: "#9ec9e9"
  agent-3: "#cbb1e9"
  agent-4: "#9bcbb4"
  agent-5: "#dbc984"
  agent-6: "#eab0c8"
  agent-7: "#87cfd0"
  agent-8: "#bcca9e"
themes:
  light:
    colors:
      canvas: "#f3f1ed"
      surface: "#fffdf9"
      rail: "#e5e2dc"
      text: "#252426"
      muted-text: "#595653"
      accent: "#8a4625"
      action-text: "#265d6b"
      on-accent: "#ffffff"
      focus: "#1a6275"
      border: "#d1cbc3"
      control-border: "#827c75"
      error: "#a42639"
      warning: "#734e10"
      warning-surface: "#fff1d3"
      success: "#326040"
      success-surface: "#e5f1e6"
      masthead: "#101113"
      masthead-text: "#f4efe9"
      own-message: "#dcebee"
      link: "#235c70"
      accent-hover: "#70371c"
      field: "#ece9e3"
      code: "#e9e6e0"
      brand: "#9ed6e0"
      primary: "#8a4625"
      warning-tray: "#faf3e2"
      alert: "#913f34"
      warning-border: "#b59149"
      success-border: "#7fa38a"
      danger-soft: "#922438"
      danger-border: "#bd7682"
      agent-1: "#784c25"
      agent-2: "#295c7a"
      agent-3: "#694888"
      agent-4: "#31674e"
      agent-5: "#66551d"
      agent-6: "#823a5c"
      agent-7: "#226269"
      agent-8: "#4a612e"
effects:
  backdrop: "rgb(16 17 19 / 0.68)"
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
- Brand (assumed) — charcoal surfaces with a copper primary action and a cool blue-green for links, navigation and keyboard focus. The header uses the [transparent app mark](public/agent-bridge.svg). The [Windows icon](assets/windows/agent-bridge.ico) uses a medium blue tile (#347BB1). The [browser icon](public/favicon.ico) uses navy.

## Interaction

Keep agents on the left and the user's messages on the right. Place the recipient before the message and the send button after it. At phone widths the recipient moves above the message. Keep status text alongside any colored indicator. Use system fonts for controls and a monospace face for code and usage figures.

## Palette

In dark mode, the masthead, canvas, message surface, team rail and controls form a solid five-step lightness scale. Copper draws attention to the primary action. Its near-complement, blue-green, marks interactive text and gives outgoing messages a quieter tint. Green, amber and red accompany explicit status labels. The light theme uses the same roles on warm neutral surfaces.

## Contrast

The default palette is dark. Light follows the system preference. The CSS tokens are in [tokens.css](public/css/tokens.css).

| Foreground | Background | Theme/state | Ratio | Minimum |
| --- | --- | --- | --- | --- |
| text | canvas | default | 15.69:1 | 4.5:1 |
| text | surface | default | 13.55:1 | 4.5:1 |
| text | own-message | default | 10.04:1 | 4.5:1 |
| text | field | default | 10.19:1 | 4.5:1 |
| muted-text | canvas | default | 9.25:1 | 4.5:1 |
| muted-text | surface | default | 7.99:1 | 4.5:1 |
| muted-text | rail | default | 6.78:1 | 4.5:1 |
| action-text | surface | default | 8.84:1 | 4.5:1 |
| on-accent | accent | default | 8.06:1 | 4.5:1 |
| on-accent | accent-hover | default | 9.68:1 | 4.5:1 |
| masthead-text | masthead | default | 16.53:1 | 4.5:1 |
| warning | warning-surface | default | 8.50:1 | 4.5:1 |
| success | success-surface | default | 7.06:1 | 4.5:1 |
| error | surface | default | 7.64:1 | 4.5:1 |
| link | canvas | default | 11.10:1 | 4.5:1 |
| muted-text | own-message | default | 5.92:1 | 4.5:1 |
| action-text | own-message | default | 6.55:1 | 4.5:1 |
| action-text | rail | default | 7.51:1 | 4.5:1 |
| text | rail | default | 11.51:1 | 4.5:1 |
| focus | canvas | default | 12.15:1 | 3:1 |
| control-border | field | default | 3.28:1 | 3:1 |
| text | canvas | light | 13.70:1 | 4.5:1 |
| text | surface | light | 15.21:1 | 4.5:1 |
| text | own-message | light | 12.63:1 | 4.5:1 |
| text | field | light | 12.75:1 | 4.5:1 |
| muted-text | canvas | light | 6.46:1 | 4.5:1 |
| muted-text | surface | light | 7.18:1 | 4.5:1 |
| muted-text | rail | light | 5.64:1 | 4.5:1 |
| action-text | surface | light | 7.23:1 | 4.5:1 |
| on-accent | accent | light | 7.04:1 | 4.5:1 |
| on-accent | accent-hover | light | 9.32:1 | 4.5:1 |
| masthead-text | masthead | light | 16.53:1 | 4.5:1 |
| warning | warning-surface | light | 6.64:1 | 4.5:1 |
| success | success-surface | light | 6.26:1 | 4.5:1 |
| error | surface | light | 7.09:1 | 4.5:1 |
| link | canvas | light | 6.56:1 | 4.5:1 |
| muted-text | own-message | light | 5.96:1 | 4.5:1 |
| action-text | own-message | light | 6.00:1 | 4.5:1 |
| action-text | rail | light | 5.68:1 | 4.5:1 |
| text | rail | light | 11.95:1 | 4.5:1 |
| focus | canvas | light | 6.11:1 | 3:1 |
| control-border | field | light | 3.41:1 | 3:1 |
