# Filesystem Sandbox

The sandbox extension (`extensions/sandbox/`) restricts the agent's filesystem access to
prevent accidental or malicious reads/writes outside the working directory.

## How It Works

Two enforcement layers work in concert:

```
User prompt
    │
    ▼
┌────────────────────────────────────────────┐
│  Layer 1 — tool_call interception           │
│  Checks path policy before every call      │
│  Covers: read, write, edit, bash (static)  │
└──────────────────┬─────────────────────────┘
                   │ bash commands pass through
                   ▼
┌────────────────────────────────────────────┐
│  Layer 2 — bwrap bash wrapper              │
│  OS-level mount namespace enforcement      │
│  Blocks all bash filesystem escapes        │
└────────────────────────────────────────────┘
```

**Layer 1 — In-process policy** intercepts `read`, `write`, `edit`, and `bash` tool
calls before they execute. For `read`/`write`/`edit` the path argument is checked
directly. For `bash` a best-effort regex scan detects redirects (`>`, `>>`, `tee`) and
common read commands (`cat`, `head`, etc.) in the command string.

**Layer 2 — bwrap OS enforcement** wraps every bash subprocess in a Linux mount
namespace (`bubblewrap`). The entire filesystem is bind-mounted read-only; configured
writable paths get a read-write bind-mount on top; inaccessible paths get an empty
`tmpfs` overlay. The kernel enforces these rules regardless of how the shell reaches a
file.

## Default Behaviour

| Path | Access |
|------|--------|
| Current working directory (`cwd`) | read-write |
| `/nix` | read-only |
| Everything else | read-only |

The `cwd` and `/nix` defaults are implicit — they are always present and cannot be
removed, only overridden by a more-specific path rule.

## Configuration

### File locations

| File | Scope |
|------|-------|
| `~/.pi/agent/sandbox.json` | Global — applies to all projects |
| `.pi/sandbox.json` | Project-level — merged on top of global |

Project values take precedence. If `.pi/sandbox.json` does not exist it is created
automatically on first run with `{ "enabled": true, "paths": [] }` (defaults only).

### Schema

```json
{
  "enabled": true,
  "stealthErrors": false,
  "paths": [
    { "path": ".",        "access": "read-write"   },
    { "path": "/tmp",     "access": "read-write"   },
    { "path": "~/.ssh",   "access": "inaccessible" },
    { "path": ".env",     "access": "inaccessible" }
  ]
}
```

### Access levels

| Value | Meaning |
|-------|---------|
| `"read-write"` | Full read and write access |
| `"read-only"` | Reads allowed, writes blocked |
| `"inaccessible"` | All access denied; directory appears empty in bash |

### Path resolution

- `~` expands to `$HOME`
- Relative paths resolve from `cwd`
- Symlinks are followed — a symlink pointing into an inaccessible path is blocked at the
  real target
- **Most specific (longest) match wins**
- Unmatched paths default to `read-only`

### `stealthErrors`

When `stealthErrors: true`, blocked-access error messages are rewritten to look like
natural OS errors instead of revealing the sandbox:

| Mode | Read error | Write error |
|------|------------|-------------|
| `false` (default) | `[sandbox] read blocked: /path is inaccessible` | `[sandbox] write blocked: /path is read-only` |
| `true` | `/path: No such file or directory` | `/path: Read-only file system` |

This affects both Layer 1 tool-call error messages and the system prompt injection.

## Toggle

```bash
# Disable for a single session
pi --no-sandbox

# Toggle at runtime
/sandbox on
/sandbox off

# Show current status and active policy (most-specific first)
/sandbox
```

Runtime toggles are session-scoped and do not persist to the config file.

## Status indicator

The footer shows the active state:

| State | Display |
|-------|---------|
| Enabled, bwrap found | `🔒 sandbox: 2 rw, 1 blocked` |
| Enabled, no bwrap | `🔒 sandbox: 2 rw, 1 blocked (bwrap not found — layer 2 disabled)` |
| Disabled | `⚠ sandbox: off` |

## System prompt injection

At agent start (`before_agent_start`) the sandbox appends a block to the system prompt
listing writable paths and inaccessible paths. This lets the agent give informed refusals
before attempting a write, rather than discovering restrictions via failed tool calls.

Example injected block:

```
## Sandbox: Filesystem Write Restrictions

The filesystem sandbox is active. Writable paths:
- `/home/dev/my-project`
- `/tmp`

All other paths are read-only. Writes outside the listed paths will fail immediately.

Inaccessible paths (cannot read or write):
- `/home/dev/my-project/.env`
```

## Requirements

| Layer | Requirement |
|-------|-------------|
| Layer 1 (in-process) | None — always active |
| Layer 2 (bwrap) | `bwrap` (bubblewrap) in `PATH` |

On NixOS using the `pi-agent` dev shell, `bwrap` is already available. If it is not
found, a warning is shown and only Layer 1 remains active.

## bwrap hardening details

The bwrap invocation includes several platform-specific hardening measures:

```
bwrap
  --ro-bind / /          # whole FS read-only
  --dev /dev             # keep /dev
  --proc /proc           # fresh procfs (own PID namespace)
  --unshare-pid          # own PID namespace — /proc only shows sandbox procs
  [--tmpfs /mnt/wslg]    # WSL2 only: shadow the ext4 rootfs mirror
  [--bind <rw-path> ...]  # configured read-write paths
  [--tmpfs <blocked> ...] # inaccessible paths → empty tmpfs overlay
  -- bash -c <command>
```

**`--unshare-pid` + `--proc /proc`** give the child its own PID namespace with a fresh
procfs. This prevents the `/proc/<host-pid>/root/` namespace-traversal escape: host
PIDs are not visible inside the namespace, so their mount-namespace roots cannot be
accessed.

**WSL2 `/mnt/wslg` tmpfs overlay** shadows WSL2's secondary ext4 mount of the host
rootfs (visible at `/mnt/wslg/distro/`). Without this, inaccessible paths could be
reached via the mirror path.

## Known limitations

### Layer 1 bash scanner is best-effort

The regex scanner detects write redirects (`>`, `>>`, `tee`) and common read tools
(`cat`, `head`, `tail`, `grep`, etc.) but does not parse arbitrary shell syntax. Access
via interpreters (`python3 -c "open('...')"`, `perl`, `awk`, `dd`) is not caught by
Layer 1. Layer 2 (bwrap) enforces these at the OS level regardless.

**Impact:** When `bwrap` is unavailable (fallback mode), arbitrary bash commands can
bypass the policy. In normal operation Layer 2 closes this gap.

### Nix store exposure

Files committed to a Nix-managed repository are stored read-only in the Nix store at
`/nix/store/<hash>-source/<path>`. The sandbox allows reading these paths (the `/nix`
implicit rule is `read-only`, not `inaccessible`). This means any file in the repo that
is part of a Nix build is readable via its store path regardless of other policy rules.

**Mitigation:** Do not commit secrets or sensitive files to a Nix-managed repository. An
`inaccessible` rule on a specific `/nix/store` path is impractical because the hash
changes with each rebuild.

### `/sandbox on` may double-register the bash tool

Calling `/sandbox on` when a bash override is already active calls `pi.registerTool` and
`pi.on("user_bash", ...)` a second time. Behaviour depends on how pi handles repeated
registration; in practice this path is only hit after an explicit `/sandbox off`.

### `stealthErrors` not re-applied on `/sandbox on`

The `stealthErrors` value from the config is read at `session_start` only. If the
sandbox is toggled off and back on via `/sandbox`, the re-loaded config's `stealthErrors`
value is not applied to the `stealth` flag.

## Audit history

| Round | Date | Result | Notes |
|-------|------|--------|-------|
| CTF 1 | 2026-04-04 | 20/20 | All escape techniques blocked |
| CTF 2 | 2026-04-04 | Escapes found | `/proc/PID/root` bypass (V1), Nix store (V2) |

CTF 2 V1 (the `/proc/PID/root` namespace-traversal escape) was fixed by adding
`--unshare-pid` and `--proc /proc` to the bwrap invocation. CTF 2 V2 (Nix store reads)
is a policy/usage issue, not a code defect.

Full findings: `docs/sandbox-ctf-findings.md`, `docs/sandbox-ctf2-findings.md`

## Related documents

- `docs/sandbox-investigation.md` — technology survey and approach selection
- `docs/sandbox-implementation-plan.md` — original design spec
- `docs/sandbox-ctf-findings.md` — CTF Round 1 audit results
- `docs/sandbox-ctf2-findings.md` — CTF Round 2 agent audit results
