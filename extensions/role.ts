/**
 * Removes the hardcoded pi role line from the system prompt,
 * optionally replacing it with a custom role.
 *
 * Set role via:
 *   - PI_ROLE env var
 *   - .pi/ROLE.md file (project-level)
 *   - ~/.pi/agent/ROLE.md (global)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PI_ROLE_LINE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

function resolveRole(): string | undefined {
	// 1. Environment variable
	if (process.env.PI_ROLE) return process.env.PI_ROLE;

	// 2. Project-level .pi/ROLE.md
	const projectRole = join(process.cwd(), ".pi", "ROLE.md");
	if (existsSync(projectRole)) return readFileSync(projectRole, "utf8").trim();

	// 3. Global ~/.pi/agent/ROLE.md
	const globalRole = join(homedir(), ".pi", "agent", "ROLE.md");
	if (existsSync(globalRole)) return readFileSync(globalRole, "utf8").trim();

	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (!event.systemPrompt?.includes(PI_ROLE_LINE)) return;

		const role = resolveRole();
		const modified = event.systemPrompt
			.replace(PI_ROLE_LINE, role ?? "")
			.replace(/^\n+/, "");

		return { systemPrompt: modified };
	});
}
