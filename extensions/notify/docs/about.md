# Notify Extension — About

The notify extension (`extensions/notify/`) sends a desktop or terminal notification
when the pi agent finishes working, **but only when the terminal is not the active window**.
This avoids notification noise when you are already watching the output.

## Focus tracking

Focus is tracked using ANSI focus-event mode (`\x1b[?1004h`). When enabled, the
terminal emits:

- `\x1b[I` — terminal gained focus
- `\x1b[O` — terminal lost focus

The extension assumes focused at session start and updates the state in real time.
Focus tracking is enabled on `session_start` and cleaned up on `session_shutdown`
(including `/reload`, `/fork`, `/new`, and `/resume`).

Most modern terminals support this protocol: Kitty, GNOME Terminal, Alacritty,
WezTerm, iTerm2, Windows Terminal, and others.

## Notification backends

Backends are probed once at `session_start`. The first available one is used:

| Priority | Backend | Platform |
|----------|---------|----------|
| 1 | OSC 777 | Terminal in-band (iTerm2, WezTerm, Ghostty, rxvt-unicode) |
| 2 | OSC 99 | Kitty in-band |
| 3 | `powershell.exe` | Windows / WSL (Windows Terminal special case) |

In-band OSC is the preferred default since it works across platforms in modern terminals.
When running inside Windows Terminal (WT_SESSION) the extension will use PowerShell
to show a native toast notification.

> **TODO:** explore additional native backends before falling back to OSC —
> e.g. `kdialog` (KDE), `dunstify` (dunst), `sw-notify` (sway/wlroots),
> `alerter` (macOS).

## Requirements

At least one of the following:

- **Any terminal with OSC support:** (preferred) no install needed — WezTerm, iTerm2, Kitty, rxvt-unicode, etc.
- **Windows/WSL:** `powershell.exe` — used when running inside Windows Terminal (WT_SESSION) for native toasts.

## Install

**Option A — project-local** (already done if you're reading this):
Reference `extensions/notify/index.ts` in `.pi/settings.json`:
```json
{
  "extensions": ["extensions/notify/index.ts"]
}
```

**Option B — global** (works across all projects):
Copy the `notify/` folder to `~/.pi/agent/extensions/notify/` and reference
`extensions/notify/index.ts` in `~/.pi/agent/settings.json`.
