// Stands in for `omp --mode rpc` in the bridge tests. It records how it was started and every line it
// reads, under its --session-dir, and speaks the frames the bridge reads. A prompt that starts with
// SCRIPT: is a JSON script of frames to emit; any other prompt gets one assistant reply.
import * as fs from "node:fs";
import * as path from "node:path";

type Frame = Record<string, unknown>;

interface Ask {
	method: string;
	title?: string;
	options?: string[];
	/** Name for a later `cancel` step. */
	label?: string;
	/** false: emit and go on; a later `waitAll` collects the answer. */
	wait?: boolean;
}

interface Step {
	start?: { toolCallId: string; toolName: string; args: Frame };
	end?: { toolCallId: string; toolName: string; text: string };
	ask?: Ask;
	cancel?: string;
	notify?: string;
	sleep?: number;
	waitAll?: boolean;
	exit?: number;
}

interface Script {
	steps?: Step[];
	final?: string;
	/** Fail the prompt with this error instead of running a turn. */
	fail?: string;
}

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--session-dir");
const recordDir = dirIndex >= 0 ? args[dirIndex + 1] : undefined;
if (!recordDir) {
	process.stderr.write("fake-omp: --session-dir is required\n");
	process.exit(2);
}
fs.mkdirSync(recordDir, { recursive: true });
fs.writeFileSync(path.join(recordDir, "launch.json"), JSON.stringify({ argv: args, env: process.env }));
const stdinLog = path.join(recordDir, "stdin.jsonl");

const pending = new Map<string, (response: Frame) => void>();
let nextUi = 1;
let turns: Promise<void> = Promise.resolve();

function emit(frame: Frame): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function handle(frame: Frame): void {
	if (frame.type === "extension_ui_response") {
		const id = String(frame.id);
		const resolve = pending.get(id);
		pending.delete(id);
		resolve?.(frame);
		return;
	}
	if (frame.type === "prompt") {
		const message = typeof frame.message === "string" ? frame.message : "";
		turns = turns.then(() => runPrompt(message, frame.id));
		return;
	}
	emit({ type: "response", command: String(frame.type), success: false, error: `fake-omp: unexpected ${frame.type}`, id: frame.id });
}

async function runPrompt(message: string, id: unknown): Promise<void> {
	if (!message.startsWith("SCRIPT:")) {
		emit({ type: "response", command: "prompt", success: true, id });
		emit({ type: "agent_start" });
		emit({ type: "agent_end", messages: [assistant(`echo: ${message}`)], isTerminal: true });
		return;
	}
	const body = JSON.parse(message.slice("SCRIPT:".length)) as Script;
	if (body.fail) {
		emit({ type: "response", command: "prompt", success: false, error: body.fail, id });
		return;
	}
	emit({ type: "response", command: "prompt", success: true, id });
	emit({ type: "agent_start" });
	const answers: Frame[] = [];
	const outstanding: Promise<void>[] = [];
	const labels = new Map<string, string>();
	for (const step of body.steps ?? []) {
		if (step.start) emit({ type: "tool_execution_start", ...step.start });
		if (step.notify) emit({ type: "extension_ui_request", id: `ui-${nextUi++}`, method: "notify", message: step.notify });
		if (step.sleep) await Bun.sleep(step.sleep);
		if (step.ask) {
			const { label, wait, ...request } = step.ask;
			const uiId = `ui-${nextUi++}`;
			if (label) labels.set(label, uiId);
			const { promise, resolve } = Promise.withResolvers<Frame>();
			pending.set(uiId, resolve);
			emit({ type: "extension_ui_request", id: uiId, ...request });
			const answered = promise.then(response => {
				answers.push({ request: uiId, value: response.value, cancelled: response.cancelled });
			});
			if (wait === false) outstanding.push(answered);
			else await answered;
		}
		if (step.cancel) {
			const uiId = labels.get(step.cancel) ?? "";
			emit({ type: "extension_ui_request", id: `ui-${nextUi++}`, method: "cancel", targetId: uiId });
			const resolve = pending.get(uiId);
			pending.delete(uiId);
			resolve?.({ cancelled: true });
		}
		if (step.waitAll) await Promise.all(outstanding.splice(0));
		if (step.end) {
			emit({
				type: "tool_execution_end",
				toolCallId: step.end.toolCallId,
				toolName: step.end.toolName,
				result: { content: [{ type: "text", text: step.end.text }] },
				isError: false,
			});
		}
		if (step.exit !== undefined) process.exit(step.exit);
	}
	emit({ type: "agent_end", messages: [assistant(body.final ?? `answers: ${JSON.stringify(answers)}`)], isTerminal: true });
}

function assistant(text: string): Frame {
	return { role: "assistant", content: [{ type: "text", text }] };
}

emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });

let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk.toString();
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line.trim()) continue;
		fs.appendFileSync(stdinLog, `${line}\n`);
		try {
			handle(JSON.parse(line) as Frame);
		} catch {
			emit({ type: "response", command: "parse", success: false, error: "fake-omp: malformed line" });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
