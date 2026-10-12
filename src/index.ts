// The part of the remote-command workflow that runs inside omp. Load it with -e, and only in the omp
// the bridge starts; it imports nothing from omp at runtime, so it loads from any folder.
//
// - RPC `bash` side door: omp hands that command to `user_bash`, past the model and the approval
//   gate, and runs it anyway when a handler throws or times out. So this handler never throws, and
//   answers everything but two read-only git commands with a refusal instead of running it.
// - Startup lock: when omp is not set up for remote use, every tool call is blocked. `tool_call` is
//   the hook omp fails closed on, so a crash here also blocks.
import type { ExtensionAPI, UserBashEventResult } from "@oh-my-pi/pi-coding-agent";

/** The only RPC `bash` commands that run, compared after trimming. */
export const SIDE_DOOR_ALLOWED: readonly string[] = ["git status --short", "git log --oneline -5"];

const NAME = "omp-remote-command";
const PREFIX = `${NAME}:`;
const YOLO_FLAGS = ["--yolo", "--auto-approve"];

type BashResult = NonNullable<UserBashEventResult["result"]>;

/** `undefined` lets omp run the command; anything else is the result omp reports instead. */
export function sideDoorRefusal(command: unknown): BashResult | undefined {
	if (typeof command === "string" && SIDE_DOOR_ALLOWED.includes(command.trim())) return undefined;
	const shown = typeof command === "string" ? command : "<unreadable>";
	const output = `blocked by ${NAME}: direct shell commands over RPC are not allowed: ${shown}`;
	const bytes = Buffer.byteLength(output);
	return {
		output,
		exitCode: 126,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: bytes,
		outputLines: 1,
		outputBytes: bytes,
	};
}

function isAllow(value: unknown): boolean {
	return typeof value === "string" && value.trim().toLowerCase() === "allow";
}

/**
 * What keeps omp from being safe to drive remotely, one line per finding; empty when it is.
 * omp normalizes approval values by trimming and lowercasing, so `Allow` counts as `allow`.
 */
export function startupProblems(get: (key: string) => unknown, argv: readonly string[]): string[] {
	const problems = YOLO_FLAGS.filter(flag => argv.includes(flag)).map(flag => `${flag} is on the command line`);
	let mode: unknown;
	let approval: unknown;
	let patterns: unknown;
	let collab: unknown;
	try {
		mode = get("tools.approvalMode");
		approval = get("tools.approval");
		patterns = get("bash.patterns");
		collab = get("collab.autoStart");
	} catch (err) {
		problems.push(`omp settings could not be read (${err instanceof Error ? err.message : String(err)})`);
		return problems;
	}
	if (mode !== "always-ask") problems.push(`tools.approvalMode is ${JSON.stringify(mode)}, not "always-ask"`);
	if (approval && typeof approval === "object") {
		for (const [tool, policy] of Object.entries(approval)) {
			if (isAllow(policy)) problems.push(`tools.approval.${tool} is "allow", which skips the owner`);
		}
	}
	if (Array.isArray(patterns)) {
		for (const rule of patterns as Array<{ match?: unknown; approval?: unknown } | null>) {
			if (isAllow(rule?.approval)) problems.push(`bash.patterns rule ${JSON.stringify(rule?.match)} is "allow", which skips the owner`);
		}
	}
	if (collab !== "off") problems.push(`collab.autoStart is ${JSON.stringify(collab)}, not "off"`);
	return problems;
}

function currentProblems(pi: ExtensionAPI): string[] {
	return startupProblems(key => (pi.pi.settings.get as (path: string) => unknown)(key), process.argv);
}

export default function remoteCommand(pi: ExtensionAPI): void {
	pi.setLabel(NAME);

	pi.on("user_bash", async event => {
		try {
			const refusal = sideDoorRefusal(event?.command);
			return refusal ? { result: refusal } : undefined;
		} catch {
			return { result: sideDoorRefusal(undefined)! };
		}
	});

	pi.on("tool_call", async () => {
		const problems = currentProblems(pi);
		if (problems.length === 0) return undefined;
		return {
			block: true,
			reason:
				`${PREFIX} omp is not set up for remote use (${problems.join("; ")}). ` +
				"Nothing runs until the bridge starts omp with its own settings. Do not try another way; report this and stop.",
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const problems = currentProblems(pi);
		if (problems.length > 0) ctx.ui.notify(`${PREFIX} omp is not set up for remote use (${problems.join("; ")})`, "error");
	});
}
