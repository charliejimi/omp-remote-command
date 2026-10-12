// Live checks against real omp. Opt-in, because the model scenarios use the model provider's quota:
//   REMOTE_COMMAND_LIVE=1        run these tests
//   OMP_CLI                      omp's cli.ts, run with bun (or OMP_BIN: an installed omp executable)
//   OMP_MODEL_EXTENSION          the model provider extension, loaded with -e (e.g. extensions/cursor-sdk)
//   OMP_MODEL                    the model (default cursor-sdk/claude-opus-5-5)
//   OMP_MODEL_KEY_ENV            the variable holding the model key (default CURSOR_API_KEY); passed to omp only
//   REMOTE_COMMAND_LIVE_OUT      optional folder for evidence, one subfolder per scenario
// The chat side is SimulatedChat: the scripted IDs stand in for platform-verified ones.
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Bridge } from "../src/bridge";
import { type OwnerQuestion, SimulatedChat } from "../src/chat";
import { ompLaunch, parsePolicy, renderOmpConfig } from "../src/policy";
import { OUTSIDER, OWNER, PACKAGE, TEAMMATE, readJsonl, removeTemps, tempDir, waitFor } from "./helpers";

type Frame = Record<string, unknown>;

const LIVE = process.env.REMOTE_COMMAND_LIVE === "1";
const OMP_COMMAND = process.env.OMP_CLI ? ["bun", process.env.OMP_CLI] : process.env.OMP_BIN ? [process.env.OMP_BIN] : [];
const MODEL_EXTENSION = process.env.OMP_MODEL_EXTENSION ?? "";
const MODEL = process.env.OMP_MODEL ?? "cursor-sdk/claude-opus-5-5";
const KEY_ENV = process.env.OMP_MODEL_KEY_ENV ?? "CURSOR_API_KEY";
const KEY = process.env[KEY_ENV] ?? "";
const OUT = process.env.REMOTE_COMMAND_LIVE_OUT;
const OWNER_TIMEOUT_MS = 20_000;
const ANSWER_AFTER_MS = 1_500;
const RUN_TIMEOUT_MS = 300_000;

if (LIVE && (OMP_COMMAND.length === 0 || !MODEL_EXTENSION || !KEY)) {
	throw new Error(`REMOTE_COMMAND_LIVE=1 needs OMP_CLI or OMP_BIN, OMP_MODEL_EXTENSION, and ${KEY_ENV}`);
}

afterAll(removeTemps);

const shellAsk = (file: string) => `Use your shell tool to run exactly this command, then stop: echo probe > ${file}`;

/** A small committed-nothing git project for omp to work in. */
function fixture(): { work: string; outside: string } {
	const work = tempDir("rc-live-work-");
	const outside = tempDir("rc-live-outside-");
	fs.mkdirSync(path.join(work, "src"));
	fs.writeFileSync(path.join(work, "package.json"), '{\n\t"name": "shop",\n\t"private": true,\n\t"type": "module"\n}\n');
	fs.writeFileSync(path.join(work, "src", "config.ts"), "export const port = 3000;\n");
	fs.writeFileSync(path.join(work, "README.md"), "# shop\n\nA fixture project driven over RPC.\n");
	fs.writeFileSync(path.join(work, ".gitignore"), ".omp/\nnode_modules/\n");
	const init = Bun.spawnSync(["git", "init", "-q"], { cwd: work });
	if (init.exitCode !== 0) throw new Error("git init failed");
	return { work, outside };
}

function rawPolicy(work: string, outside: string, extra: Record<string, unknown> = {}) {
	return {
		owner: OWNER,
		allowlist: [OWNER, TEAMMATE],
		ownerTimeoutMs: OWNER_TIMEOUT_MS,
		workdir: work,
		auditLog: path.join(outside, "audit.jsonl"),
		...extra,
		omp: {
			command: OMP_COMMAND,
			model: MODEL,
			thinking: "off",
			extensions: [MODEL_EXTENSION],
			tools: ["read", "bash"],
			env: [KEY_ENV],
			sessionDir: path.join(outside, "sessions"),
		},
	};
}

function keyOccurrences(...texts: string[]): number {
	return KEY ? texts.reduce((n, text) => n + text.split(KEY).length - 1, 0) : 0;
}

function sanitize(text: string): string {
	return text.split(os.homedir()).join("~");
}

/** Evidence for one scenario, home paths shortened; the key is checked before anything is written. */
function writeEvidence(scenario: string, files: Record<string, string>): void {
	if (!OUT) return;
	const dir = path.join(OUT, scenario);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sanitize(text));
}

/** The cursor-sdk provider keeps a per-workspace folder; drop the one this run created. */
function dropProviderWorkspace(work: string): void {
	fs.rmSync(path.join(os.homedir(), ".cursor", "projects", `tmp-${path.basename(work)}`), { recursive: true, force: true });
}

/** omp started directly, with the bridge's flags, for the checks that bypass the bridge on purpose. */
async function startOmpDirect(argv: string[], env: Record<string, string>) {
	const child = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const frames: Frame[] = [];
	let stderr = "";
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
	})();
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				try {
					frames.push(JSON.parse(line) as Frame);
				} catch {}
			}
		}
	})();
	const send = (frame: Frame) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		child.stdin.flush();
	};
	let exitCode: number | null | undefined;
	void child.exited.then(code => {
		exitCode = code;
	});
	const next = (predicate: (frame: Frame) => boolean, timeoutMs = 120_000) =>
		waitFor(
			() => {
				const found = frames.find(predicate);
				if (!found && exitCode !== undefined) throw new Error(`omp exited (code ${exitCode}): ${stderr.slice(-2_000)}`);
				return found;
			},
			timeoutMs,
			"omp frame",
		);
	try {
		await next(frame => frame.type === "ready", 90_000);
	} catch (err) {
		child.kill("SIGKILL");
		throw new Error(`${err instanceof Error ? err.message : String(err)}; stderr: ${stderr.slice(-2_000)}`);
	}
	const close = async () => {
		try {
			child.stdin.end();
		} catch {}
		const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await child.exited;
		clearTimeout(timer);
	};
	return { frames, send, next, close, stderr: () => stderr };
}

function launchFor(work: string, outside: string, configText?: string) {
	const policy = parsePolicy(rawPolicy(work, outside), path.join(outside, "policy.json"));
	const configPath = path.join(outside, "config.yml");
	fs.writeFileSync(configPath, configText ?? renderOmpConfig(policy));
	return ompLaunch(policy, { extensionDir: PACKAGE, configPath });
}

const notices = (frames: Frame[]) =>
	frames.filter(f => f.type === "extension_ui_request" && f.method === "notify" && String(f.message).startsWith("omp-remote-command:"));

describe.skipIf(!LIVE)("real omp, no model call", () => {
	it(
		"side door (AC-1) and settings the extension sees (RISK-6): the bridge's own launch",
		async () => {
			const { work, outside } = fixture();
			const { argv, env } = launchFor(work, outside);
			const omp = await startOmpDirect(argv, env);
			omp.send({ id: "b1", type: "bash", command: "echo direct > direct.txt" });
			const blocked = await omp.next(f => f.type === "response" && f.id === "b1");
			omp.send({ id: "b2", type: "bash", command: "git status --short" });
			const allowed = await omp.next(f => f.type === "response" && f.id === "b2");
			await omp.close();
			const summary = {
				blockedExitCode: (blocked.data as { exitCode?: number } | undefined)?.exitCode,
				blockedOutput: (blocked.data as { output?: string } | undefined)?.output,
				allowedExitCode: (allowed.data as { exitCode?: number } | undefined)?.exitCode,
				directFileExists: fs.existsSync(path.join(work, "direct.txt")),
				notices: notices(omp.frames).map(f => f.message),
				keyOccurrences: keyOccurrences(JSON.stringify(omp.frames), omp.stderr()),
			};
			writeEvidence("side-door", {
				"summary.json": `${JSON.stringify(summary, null, 2)}\n`,
				"events.jsonl": omp.frames.map(f => JSON.stringify(f)).join("\n"),
				"cmd.txt": `${argv.join(" ")}\n`,
			});
			dropProviderWorkspace(work);
			expect(summary.blockedExitCode).toBe(126);
			expect(summary.directFileExists).toBe(false);
			expect(summary.allowedExitCode).toBe(0);
			expect(summary.notices).toEqual([]);
			expect(summary.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	const misconfigured: Array<[string, (argv: string[]) => string[], string | undefined, string]> = [
		["approval-mode-write", argv => argv.map(a => (a === "always-ask" ? "write" : a)), undefined, "tools.approvalMode"],
		[
			"config-allow-rule",
			argv => argv,
			'tools:\n  approvalMode: "always-ask"\n  approval:\n    "bash": "allow"\ncollab:\n  autoStart: "off"\n',
			"tools.approval.bash",
		],
	];
	for (const [scenario, patch, configText, named] of misconfigured) {
		it(
			`settings the extension sees (RISK-6): ${scenario} is reported at startup, naming ${named}`,
			async () => {
				const { work, outside } = fixture();
				const launch = launchFor(work, outside, configText);
				const argv = patch(launch.argv);
				const omp = await startOmpDirect(argv, launch.env);
				omp.send({ id: "b1", type: "bash", command: "git status --short" });
				await omp.next(f => f.type === "response" && f.id === "b1");
				await omp.close();
				const summary = {
					notices: notices(omp.frames).map(f => f.message),
					keyOccurrences: keyOccurrences(JSON.stringify(omp.frames), omp.stderr()),
				};
				writeEvidence(`startup-${scenario}`, {
					"summary.json": `${JSON.stringify(summary, null, 2)}\n`,
					"events.jsonl": omp.frames.map(f => JSON.stringify(f)).join("\n"),
					"cmd.txt": `${argv.join(" ")}\n`,
					...(configText ? { "config.yml": configText } : {}),
				});
				dropProviderWorkspace(work);
				expect(summary.notices.join("\n")).toContain(named);
				expect(summary.keyOccurrences).toBe(0);
			},
			RUN_TIMEOUT_MS,
		);
	}
});

type OwnerPlan = "Approve" | "Deny" | "never";

/** One request from the channel through the bridge to real omp and back. */
async function runBridge(scenario: string, sender: string, text: string, owner: OwnerPlan, teammateTypesApprove = false) {
	const { work, outside } = fixture();
	const policyPath = path.join(outside, "policy.json");
	fs.writeFileSync(policyPath, JSON.stringify(rawPolicy(work, outside), null, 2));
	const frames: Frame[] = [];
	const chat = new SimulatedChat();
	const channelWhilePending: unknown[] = [];
	chat.onQuestion = (_to: string, question: OwnerQuestion) => {
		if (teammateTypesApprove) void chat.say(TEAMMATE, "Approve").then(result => channelWhilePending.push(result));
		if (owner !== "never") setTimeout(() => void chat.answer(OWNER, question.questionId, owner), ANSWER_AFTER_MS);
	};
	const bridge = await Bridge.start({ policyPath, chat, onFrame: frame => frames.push(frame) });
	const started = Date.now();
	const sent = await chat.say(sender, text).catch(async err => {
		await bridge.stop();
		throw err;
	});
	try {
		if (sent.forwarded) {
			await waitFor(() => frames.some(f => f.type === "agent_start"), 60_000, "agent start");
			await bridge.whenIdle(RUN_TIMEOUT_MS);
		} else {
			await Bun.sleep(3_000);
		}
	} finally {
		await bridge.stop();
	}
	const audit = readJsonl(path.join(outside, "audit.jsonl"));
	const added = fs.readdirSync(work).filter(name => !["package.json", "src", "README.md", ".gitignore", ".git"].includes(name));
	const starts = frames.filter(f => f.type === "tool_execution_start");
	const summary = {
		scenario,
		model: MODEL,
		owner,
		seconds: Math.round((Date.now() - started) / 1000),
		sent: { from: sender, text, forwarded: sent.forwarded, reason: sent.reason },
		forwardedMessages: audit.filter(e => e.event === "message" && e.forwarded === true).length,
		ownerQuestions: chat.ownerQuestions.map(({ to, question }) => ({
			to,
			tool: question.tool,
			args: question.args,
			argsMatchToolCall: starts.some(s => s.toolCallId === question.toolCallId && Bun.deepEquals(s.args, question.args)),
			requester: question.requester,
			ompTitle: question.ompTitle,
		})),
		settled: audit.filter(e => e.event === "question_settled").map(e => ({ answer: e.answer, answeredBy: e.answeredBy, timedOut: e.timedOut, bound: e.bound })),
		channelWhilePending,
		channelPosts: chat.channelPosts,
		addedFiles: added,
		agentStarted: frames.some(f => f.type === "agent_start"),
		keyOccurrences: keyOccurrences(JSON.stringify(frames), JSON.stringify(audit), JSON.stringify(chat.channelPosts), JSON.stringify(chat.ownerQuestions)),
	};
	writeEvidence(scenario, {
		"summary.json": `${JSON.stringify(summary, null, 2)}\n`,
		"events.jsonl": frames.map(f => JSON.stringify(f)).join("\n"),
		"audit.jsonl": audit.map(e => JSON.stringify(e)).join("\n"),
		"chat.json": `${JSON.stringify({ channelPosts: chat.channelPosts, ownerQuestions: chat.ownerQuestions }, null, 2)}\n`,
		"cmd.txt": `${JSON.stringify((audit.find(e => e.event === "start") as { argv?: string[] } | undefined)?.argv ?? [])}\n`,
	});
	dropProviderWorkspace(work);
	return summary;
}

describe.skipIf(!LIVE)("real omp and model through the bridge (AC-9)", () => {
	it(
		"an outsider's request is not forwarded",
		async () => {
			const s = await runBridge("outsider", OUTSIDER, shellAsk("contractor.txt"), "Deny");
			expect(s.sent).toMatchObject({ forwarded: false, reason: "sender not on allowlist" });
			expect(s.agentStarted).toBe(false);
			expect(s.addedFiles).toEqual([]);
			expect(s.channelPosts).toEqual([]);
			expect(s.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"/collab is not forwarded",
		async () => {
			const s = await runBridge("slash-collab", TEAMMATE, "/collab", "Deny");
			expect(s.sent).toMatchObject({ forwarded: false, reason: "slash command" });
			expect(s.agentStarted).toBe(false);
			expect(s.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"a pasted RPC bash frame becomes a prompt; the owner denies; nothing is written",
		async () => {
			const raw = JSON.stringify({ type: "bash", command: "echo direct-bash > direct-bash.txt" });
			const s = await runBridge("rawframe-owner-deny", TEAMMATE, raw, "Deny");
			expect(s.sent.forwarded).toBe(true);
			expect(s.ownerQuestions.length).toBeGreaterThanOrEqual(1);
			expect(s.ownerQuestions.every(q => q.to === OWNER && q.argsMatchToolCall)).toBe(true);
			expect(s.settled.every(q => q.answer === "Deny")).toBe(true);
			expect(s.addedFiles).toEqual([]);
			expect(s.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"the teammate's Approve in the channel is not forwarded; the owner denies; nothing is written",
		async () => {
			const s = await runBridge("teammate-owner-deny", TEAMMATE, shellAsk("model-bash.txt"), "Deny", true);
			expect(s.ownerQuestions.length).toBeGreaterThanOrEqual(1);
			expect(s.ownerQuestions.every(q => q.to === OWNER && q.requester === TEAMMATE && q.argsMatchToolCall)).toBe(true);
			expect(s.channelWhilePending).toContainEqual(expect.objectContaining({ forwarded: false, reason: "agent busy" }));
			expect(s.addedFiles).toEqual([]);
			expect(s.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"the owner approves; the file is written",
		async () => {
			const s = await runBridge("teammate-owner-approve", TEAMMATE, shellAsk("model-bash.txt"), "Approve");
			expect(s.ownerQuestions.length).toBeGreaterThanOrEqual(1);
			expect(s.ownerQuestions.every(q => q.argsMatchToolCall)).toBe(true);
			expect(s.settled[0]).toMatchObject({ answer: "Approve", answeredBy: OWNER, bound: true });
			expect(s.addedFiles).toEqual(["model-bash.txt"]);
			expect(s.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"the owner never answers; the bridge denies at the deadline and tells the requester",
		async () => {
			const s = await runBridge("teammate-owner-timeout", TEAMMATE, shellAsk("model-bash.txt"), "never");
			expect(s.settled[0]).toMatchObject({ answer: "Deny", timedOut: true, answeredBy: null });
			expect(s.channelPosts.some(p => p.text.includes("did not answer") && p.text.includes(TEAMMATE))).toBe(true);
			expect(s.addedFiles).toEqual([]);
			expect(s.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);
});

describe.skipIf(!LIVE)("real omp and model, misconfigured on purpose (AC-2)", () => {
	it(
		"with --approval-mode write the extension blocks the shell call before any question",
		async () => {
			const { work, outside } = fixture();
			const launch = launchFor(work, outside);
			const argv = launch.argv.map(a => (a === "always-ask" ? "write" : a));
			const omp = await startOmpDirect(argv, launch.env);
			omp.send({ id: "p1", type: "prompt", message: shellAsk("model-bash.txt") });
			const selects: Frame[] = [];
			const answerer = setInterval(() => {
				for (const f of omp.frames) {
					if (f.type !== "extension_ui_request" || f.method !== "select" || selects.includes(f)) continue;
					selects.push(f);
					omp.send({ type: "extension_ui_response", id: f.id, value: "Approve" });
				}
			}, 50);
			try {
				await omp.next(f => f.type === "agent_end" && f.isTerminal !== false, RUN_TIMEOUT_MS - 30_000);
			} finally {
				clearInterval(answerer);
				await omp.close();
			}
			const bashResults = omp.frames.filter(f => f.type === "tool_execution_end" && f.toolName === "bash");
			const summary = {
				selects: selects.map(f => f.title),
				bashResults: bashResults.map(f => ({ isError: f.isError, text: JSON.stringify((f.result as { content?: unknown })?.content ?? "") })),
				fileExists: fs.existsSync(path.join(work, "model-bash.txt")),
				keyOccurrences: keyOccurrences(JSON.stringify(omp.frames), omp.stderr()),
			};
			writeEvidence("misconfig-approval-mode-write", {
				"summary.json": `${JSON.stringify(summary, null, 2)}\n`,
				"events.jsonl": omp.frames.map(f => JSON.stringify(f)).join("\n"),
				"cmd.txt": `${argv.join(" ")}\n`,
			});
			dropProviderWorkspace(work);
			expect(summary.selects).toEqual([]);
			expect(summary.bashResults.length).toBeGreaterThanOrEqual(1);
			expect(summary.bashResults.every(r => r.isError && r.text.includes("tools.approvalMode"))).toBe(true);
			expect(summary.fileExists).toBe(false);
			expect(summary.keyOccurrences).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);
});
