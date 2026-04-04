# Filesystem Sandbox

The sandbox extension restricts the agent's filesystem access to prevent accidental or malicious access outside the working directory.

## How It Works

Two enforcement layers:

1. **In-process policy** — intercepts `read`, `write`, `edit`, and `bash` tool calls before they execute and checks all file paths against the access policy.
2. **bwrap OS enforcement** — wraps bash subprocesses in a Linux mount namespace so shell-level filesystem escapes are blocked at the kernel.

## Default Behavior

| Path | Access |
|------|--------|
| Current working directory (`cwd`) | read-write |
| Everything else | read-only |

## Configuration

**`.pi/sandbox.json`** (project-level, checked into git):

```json
{
  "enabled": true,
  "paths": [
    { "path": ".",        "access": "read-write"   },
    { "path": "/tmp",     "access": "read-write"   },
    { "path": "~/.ssh",   "access": "inaccessible" },
    { "path": ".env",     "access": "inaccessible" }
  ]
}
```

**`~/.pi/agent/sandbox.json`** (global, applies to all projects):

Same schema. Project config is merged on top, with project values taking precedence.

### Access Levels

| Value | Meaning |
|-------|---------|
| `"read-write"` | Full access |
| `"read-only"` | Reads allowed, writes blocked |
| `"inaccessible"` | All access denied (appears as empty dir in bash) |

### Path Resolution

- Paths starting with `~` expand to `$HOME`
- Relative paths resolve from `cwd`
- Most specific (longest) match wins
- Unmatched paths default to `read-only`

## Toggle

```bash
# Disable for a session
pi --no-sandbox

# Toggle at runtime
/sandbox on
/sandbox off

# Show current status and active policy
/sandbox
```

## Requirements

- **Layer 1** (in-process): no dependencies
- **Layer 2** (OS enforcement): requires `bwrap` (bubblewrap) in `PATH`
  - NixOS: already in the `pi-agent` dev shell
  - If `bwrap` is not found, a warning is shown and Layer 1 continues to operate
