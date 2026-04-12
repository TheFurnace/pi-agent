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
 * ─── Notification body modes ──────────────────────────────────────────────────
 *
 *   "basic"  — "<cwd-basename> (<branch>) · <duration>s"
 *              Zero latency. Git branch is resolved at notification time.
 *
 *   "smart"  — "<last-reply-snippet> · <tool-activity> · <cwd> · <duration>s"
 *              Extracts the first sentence of the final assistant message and
 *              builds a concise tool-activity summary from the run's tool
 *              calls (files edited, bash commands run, etc.). No network
 *              requests.
 *
 *   "ai"     — "<gpt-4o-mini-summary> · <cwd> · <duration>s"
 *              Sends the user's original prompt, tool-activity summary, and
 *              the last assistant reply snippet to gpt-4o-mini to produce a
 *              crisp one-phrase summary. Falls back to "smart" on any error.
 *              Requires OPENAI_API_KEY in the environment. The request uses a
 *              3-second timeout so failures are silent and fast.
 *
 * Set PI_NOTIFY_MODE=basic|smart|ai to choose (default: "smart").
 *
 * TODO: explore per-distro / per-DE native backends more broadly before
 *       falling back to OSC sequences — e.g. kdialog (KDE), dunstify (dunst),
 *       sw-notify (sway/wlroots), alerter (macOS).
 *
 * Install: add to extensions in .pi/settings.json, or copy the folder to
 *          ~/.pi/agent/extensions/notify/
 * Requirements: one of the native backends above, or a terminal with OSC support
 */

import type { AgentMessage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";

// ─── Configuration ─────────────────────────────────────────────────────────

type NotifyMode = "basic" | "smart" | "ai";

const CONFIG = {
	/**
	 * Notification body mode.
	 *
	 * Override at runtime with the PI_NOTIFY_MODE environment variable:
	 *   PI_NOTIFY_MODE=ai pi
	 */
	mode: (process.env.PI_NOTIFY_MODE ?? "smart") as NotifyMode,

	/** OpenAI model used in "ai" mode. */
	aiModel: "gpt-4o-mini",

	/**
	 * Hard cap on the rendered notification body in characters.
	 * Characters beyond this limit are replaced with "…".
	 */
	maxBodyLength: 120,
};

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Truncate text and append "…" if it exceeds max characters. */
function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/**
 * Extract the first sentence from text.
 * Falls back to the first line when no sentence-ending punctuation is found
 * within a reasonable range.
 */
function firstSentence(text: string): string {
	// Match a sentence that's at least 8 chars ending in . ! or ?
	const match = text.match(/^.{8,}?[.!?](?:\s|$)/);
	if (match) return match[0].trim();
	// Fallback: first non-empty line
	return text.split("\n").find(l => l.trim().length > 0)?.trim() ?? text.trim();
}

/**
 * Find the last assistant message in a messages array and return its text
 * content blocks joined into a single string.
 */
function extractLastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const textBlocks = msg.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => (b.text as string).trim())
				.filter(Boolean);
			if (textBlocks.length > 0) return textBlocks.join(" ");
		}
	}
	return "";
}

// ─── Tool-activity tracking ───────────────────────────────────────────────────

interface ToolEntry {
	name: string;
	args: any;
	isError: boolean;
}

/**
 * Build a concise human-readable summary of which tools ran during the
 * agent turn.
 *
 * Examples:
 *   "edited auth.ts"
 *   "edited 3 files, ran 2 commands"
 *   "ran 1 command"
 */
function buildToolSummary(log: ToolEntry[]): string {
	const editedFiles = new Set<string>();
	let bashCount = 0;

	for (const { name, args } of log) {
		if (name === "edit" || name === "write") {
			const filePath: string | undefined = args?.path;
			if (filePath) editedFiles.add(path.basename(filePath));
		} else if (name === "bash") {
			bashCount++;
		}
	}

	const parts: string[] = [];

	if (editedFiles.size === 1) {
		parts.push(`edited ${[...editedFiles][0]}`);
	} else if (editedFiles.size > 1) {
		parts.push(`edited ${editedFiles.size} files`);
	}

	if (bashCount === 1) {
		parts.push("ran 1 command");
	} else if (bashCount > 1) {
		parts.push(`ran ${bashCount} commands`);
	}

	return parts.join(", ");
}

// ─── Git branch ───────────────────────────────────────────────────────────────

/**
 * Return the current git branch name for the given directory.
 * Returns an empty string if git is not available or not in a repo.
 */
async function getGitBranch(cwd: string, exec: ExtensionAPI["exec"]): Promise<string> {
	try {
		const result = await exec("git", ["branch", "--show-current"], { cwd, timeout: 2000 });
		return result.stdout.trim();
	} catch {
		return "";
	}
}

// ─── AI summary ───────────────────────────────────────────────────────────────

/**
 * Ask gpt-4o-mini to produce a single short phrase summarising what was done.
 *
 * Throws on any error (network, missing key, timeout) so the caller can fall
 * back gracefully.
 */
async function generateAiSummary(
	userPrompt: string,
	toolSummary: string,
	lastReply: string,
	model: string,
): Promise<string> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY not set");

	const contextLines: string[] = [];
	if (userPrompt) contextLines.push(`Task: ${userPrompt.slice(0, 200)}`);
	if (toolSummary)  contextLines.push(`Actions: ${toolSummary}`);
	if (lastReply)    contextLines.push(`Result: ${lastReply.slice(0, 300)}`);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);

	try {
		const response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				max_tokens: 25,
				temperature: 0,
				messages: [
					{
						role: "system",
						content:
							"You generate desktop notification bodies for a coding agent. " +
							"Write exactly one short phrase (≤10 words) that concisely describes " +
							"what was accomplished. Be specific. No trailing period.",
					},
					{ role: "user", content: contextLines.join("\n") },
				],
			}),
		});

		if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);

		const data = await response.json() as any;
		const text = (data?.choices?.[0]?.message?.content as string | undefined)?.trim() ?? "";
		if (!text) throw new Error("Empty response from OpenAI");
		return text;
	} finally {
		clearTimeout(timer);
	}
}

// ─── Body builder ─────────────────────────────────────────────────────────────

interface RunState {
	startTime: number;
	userPrompt: string;
	toolLog: ToolEntry[];
}

async function buildNotificationBody(
	mode: NotifyMode,
	messages: AgentMessage[],
	run: RunState,
	cwd: string,
	exec: ExtensionAPI["exec"],
): Promise<string> {
	// Always resolve git branch and duration — they appear in every mode.
	const [branch, elapsedSec] = await Promise.all([
		getGitBranch(cwd, exec),
		Promise.resolve(run.startTime > 0 ? Math.round((Date.now() - run.startTime) / 1000) : 0),
	]);

	const cwdName    = path.basename(cwd);
	const locationPart = branch ? `${cwdName} (${branch})` : cwdName;
	const timePart     = elapsedSec > 0 ? `${elapsedSec}s` : "";
	const meta         = [locationPart, timePart].filter(Boolean).join(" · ");

	// ── basic ─────────────────────────────────────────────────────────────────
	if (mode === "basic") {
		return truncate(meta, CONFIG.maxBodyLength);
	}

	// ── smart & ai — shared enrichment ───────────────────────────────────────
	const toolSummary = buildToolSummary(run.toolLog);
	const rawReply    = extractLastAssistantText(messages);
	const snippet     = rawReply ? truncate(firstSentence(rawReply), 60) : "";

	const smartBody = (): string => {
		const parts = [snippet, toolSummary, meta].filter(Boolean);
		return truncate(parts.join(" · "), CONFIG.maxBodyLength);
	};

	if (mode === "smart") return smartBody();

	// ── ai ────────────────────────────────────────────────────────────────────
	try {
		const summary = await generateAiSummary(run.userPrompt, toolSummary, rawReply, CONFIG.aiModel);
		const parts   = [summary, meta].filter(Boolean);
		return truncate(parts.join(" · "), CONFIG.maxBodyLength);
	} catch {
		// Silent fallback to smart — don't let AI errors break notifications.
		return smartBody();
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Focus tracking state ─────────────────────────────────────────────────
	let isFocused      = true;
	let trackingActive = false;
	let stdinListener: ((chunk: Buffer) => void) | null = null;
	let backend: Backend = "osc777";

	// ── Per-agent-run state ───────────────────────────────────────────────────
	let runState: RunState = { startTime: 0, userPrompt: "", toolLog: [] };

	// ── Focus helpers ─────────────────────────────────────────────────────────
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

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		isFocused = true;
		backend   = probeBackend();
		enableFocusTracking();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		disableFocusTracking();
	});

	// ── Per-run tracking ──────────────────────────────────────────────────────

	/** Capture the user's original prompt and reset per-run state. */
	pi.on("before_agent_start", async (event, _ctx) => {
		runState = {
			startTime:  Date.now(),
			userPrompt: event.prompt.trim(),
			toolLog:    [],
		};
	});

	/** Track every tool call for the tool-activity summary. */
	pi.on("tool_execution_end", async (event, _ctx) => {
		runState.toolLog.push({
			name:    event.toolName,
			args:    event.args,
			isError: event.isError,
		});
	});

	// ── Notification ──────────────────────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (isFocused) return;

		const body = await buildNotificationBody(
			CONFIG.mode,
			event.messages,
			runState,
			ctx.cwd,
			pi.exec.bind(pi),
		);

		sendNotification(backend, "Pi", body);
	});
}
