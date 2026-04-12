/**
 * Notify Extension
 *
 * Focus-aware notification when the agent finishes working.
 * Only fires when the terminal is not the active window — avoids noise when
 * you are already watching the output.
 *
 * Focus tracking uses ANSI focus-event mode (\x1b[?1004h): the terminal emits
 * \x1b[I on focus-gained and \x1b[O on focus-lost. Most modern terminals
 * support this (Kitty, GNOME Terminal, Alacritty, WezTerm, iTerm2,
 * Windows Terminal, etc.).
 *
 * Notification backends (probed once at session start, first available wins):
 *   1. OSC 777       — terminal in-band (iTerm2, WezTerm, Ghostty, rxvt-unicode)
 *   2. OSC 99        — Kitty in-band
 *   3. powershell    — Windows / WSL toast (special handling for Windows Terminal)
 *
 * TODO: explore per-distro / per-DE native backends more broadly before
 *       falling back to OSC sequences — e.g. kdialog (KDE), dunstify (dunst),
 *       sw-notify (sway/wlroots), alerter (macOS).
 *
 * Install: add to extensions in .pi/settings.json, or copy the folder to
 *          ~/.pi/agent/extensions/notify/
 * Requirements: one of the native backends above, or a terminal with OSC support
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";

// ─── ANSI focus-event tracking ────────────────────────────────────────────────

const FOCUS_ENABLE  = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const SEQ_FOCUS_IN  = "\x1b[I";
const SEQ_FOCUS_OUT = "\x1b[O";

// ─── Notification backends ────────────────────────────────────────────────────

type Backend = "powershell" | "osc777" | "osc99";

/** Pick OSC variant based on the running terminal. */
function oscFallback(): "osc777" | "osc99" {
	return process.env.KITTY_WINDOW_ID ? "osc99" : "osc777";
}

/**
 * Probe for the best available notification backend.
 * Prefer in-band OSC notifications by default. Use PowerShell toast when running
 * inside Windows Terminal (WT_SESSION).
 */
function probeBackend(): Backend {
	// Windows Terminal sets WT_SESSION; use PowerShell toast there.
	if (process.env.WT_SESSION) return "powershell";
	return oscFallback();
}

// ─── Per-backend dispatch ─────────────────────────────────────────────────────

function windowsToastScript(title: string, body: string): string {
	const type     = "Windows.UI.Notifications";
	const mgr      = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast    = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function sendNotification(backend: Backend, title: string, body: string): void {
	switch (backend) {
		case "powershell":
			execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => {});
			break;

		case "osc777":
			// Supported by Ghostty, iTerm2, WezTerm, rxvt-unicode
			process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
			break;

		case "osc99":
			// Kitty OSC 99: i = notification id, d = 0 (not done), p = body part
			process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
			process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
			break;
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Assume focused at startup — the user just launched pi
	let isFocused     = true;
	let trackingActive = false;
	let stdinListener: ((chunk: Buffer) => void) | null = null;
	let backend: Backend = "osc777";

	function enableFocusTracking() {
		if (trackingActive) return;
		process.stdout.write(FOCUS_ENABLE);
		stdinListener = (chunk: Buffer) => {
			const str = chunk.toString("binary");
			if (str.includes(SEQ_FOCUS_IN))  isFocused = true;
			if (str.includes(SEQ_FOCUS_OUT)) isFocused = false;
		};
		process.stdin.on("data", stdinListener);
		trackingActive = true;
	}

	function disableFocusTracking() {
		if (!trackingActive) return;
		process.stdout.write(FOCUS_DISABLE);
		if (stdinListener) {
			process.stdin.removeListener("data", stdinListener);
			stdinListener = null;
		}
		trackingActive = false;
	}

	// Enable focus tracking when a session becomes active.
	// Covers initial launch, /new, /resume, and /fork.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		isFocused = true;
		backend   = probeBackend();
		enableFocusTracking();
	});

	// Clean up on exit, /new, /resume, /fork, /reload
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		disableFocusTracking();
	});

	// Send notification when the agent finishes, but only if not focused
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!isFocused) {
			sendNotification(backend, "Pi", "Agent finished working");
		}
	});
}
