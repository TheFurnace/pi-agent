# Notify Extension — About

The notify extension (`extensions/notify/`) sends a desktop or terminal notification
when the pi agent finishes working, **but only when the terminal is not the active window**.
This avoids notification noise when you are already watching the output.

## Notification body modes

The body of the notification is controlled by the `PI_NOTIFY_MODE` environment variable
(default: `smart`).

### `basic`

```
myapp (main) · 12s
```

Shows the working directory name, current git branch, and elapsed time. Zero latency —
no LLM calls, no extra I/O beyond a single `git branch` command.

### `smart` (default)

```
Fixed the login flow · edited auth.ts, ran 3 commands · myapp (main) · 12s
```

Automatically extracts the first sentence of the agent's final reply and builds a
concise tool-activity summary from the tool calls that ran during the turn
(files edited via `edit`/`write`, bash commands counted). All data comes from what
pi already has in memory — no network requests.

### `ai`

```
Refactored JWT validation and updated auth tests · myapp (main) · 12s
```

Sends the user's original prompt, the tool-activity summary, and a snippet of the
agent's last reply to **gpt-4o-mini** to produce a crisp one-phrase description of
what was accomplished. Falls back silently to `smart` on any error (missing API key,
network failure, timeout). The request uses a 3-second timeout to keep failures fast.

**Requires:** `OPENAI_API_KEY` set in the environment.

### Configuration

```bash
# Choose a mode
PI_NOTIFY_MODE=basic pi
PI_NOTIFY_MODE=smart pi   # default
PI_NOTIFY_MODE=ai    pi

# Persist in your shell profile
export PI_NOTIFY_MODE=ai
```

You can also edit `CONFIG` at the top of `index.ts` to change the default mode,
the OpenAI model (`aiModel`), or the maximum notification body length (`maxBodyLength`).

---

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
- **`ai` mode only:** `OPENAI_API_KEY` environment variable pointing to an OpenAI key with access to `gpt-4o-mini`.

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
