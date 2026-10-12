import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Bridge } from "../src/bridge";
import { SimulatedChat } from "../src/chat";
import { PolicyError } from "../src/policy";
import {
	OUTSIDER,
	OWNER,
	PACKAGE,
	TEAMMATE,
	bashApproval,
	bridgeFixture,
	removeTemps,
	script,
	stopBridges,
	tempDir,
	waitFor,
} from "./helpers";

afterEach(async () => {
	await stopBridges();
	removeTemps();
});

type Fixture = Awaited<ReturnType<typeof bridgeFixture>>;

/** Every frame the bridge wrote to omp is a prompt or an answer to a dialog (AC-4). */
function expectOnlyPromptsAndAnswers(f: Fixture): void {
	const types = new Set(f.stdinFrames().map(frame => frame.type));
	for (const type of types) expect(["prompt", "extension_ui_response"]).toContain(String(type));
}

async function question(f: Fixture, count = 1) {
	const questions = await waitFor(() => f.chat.ownerQuestions.length >= count && f.chat.ownerQuestions, 10_000, "owner question");
	return questions[count - 1]!.question;
}

const turnEnded = (f: Fixture) => waitFor(() => f.audit().some(e => e.event === "turn_end"), 10_000, "turn end");

describe("entry (AC-3)", () => {
	it("forwards nothing from a sender off the allowlist and says nothing back", async () => {
		const f = await bridgeFixture();
		const result = await f.chat.say(OUTSIDER, "Use your shell tool to run: echo probe > contractor.txt");
		expect(result).toMatchObject({ forwarded: false, reason: "sender not on allowlist" });
		await Bun.sleep(100);
		expect(f.stdinFrames()).toEqual([]);
		expect(f.chat.channelPosts).toEqual([]);
		expect(f.audit().find(e => e.event === "message")).toMatchObject({ from: OUTSIDER, forwarded: false, reason: "sender not on allowlist" });
	});

	it("forwards no slash command, even after leading whitespace", async () => {
		const f = await bridgeFixture();
		for (const text of ["/collab", " /mcp list", "\t/share"]) {
			expect(await f.chat.say(TEAMMATE, text)).toMatchObject({ forwarded: false, reason: "slash command" });
		}
		await Bun.sleep(100);
		expect(f.stdinFrames()).toEqual([]);
	});

	it("forwards nothing while a turn runs, so Approve typed in the channel cannot answer a question", async () => {
		const f = await bridgeFixture();
		await f.chat.say(TEAMMATE, bashApproval("echo probe > model-bash.txt"));
		const q = await question(f);
		expect(await f.chat.say(TEAMMATE, "Approve")).toMatchObject({ forwarded: false, reason: "agent busy" });
		await f.chat.answer(OWNER, q.questionId, "Deny");
		await turnEnded(f);
		expect(f.stdinFrames().filter(frame => frame.type === "prompt")).toHaveLength(1);
		expect(f.responses()).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Deny" }]);
		expectOnlyPromptsAndAnswers(f);
	});

	it("re-reads the allowlist for every message, so a removed sender is refused without a restart", async () => {
		const f = await bridgeFixture();
		expect(await f.chat.say(TEAMMATE, "hello")).toMatchObject({ forwarded: true });
		await turnEnded(f);
		fs.writeFileSync(f.policyPath, JSON.stringify({ ...f.policy, allowlist: [OWNER] }, null, 2));
		expect(await f.chat.say(TEAMMATE, "hello again")).toMatchObject({ forwarded: false, reason: "sender not on allowlist" });
		expect(f.stdinFrames().filter(frame => frame.type === "prompt")).toHaveLength(1);
	});

	it("refuses to start on an invalid policy and starts no omp", async () => {
		const outside = tempDir("rc-invalid-");
		const work = tempDir("rc-invalid-work-");
		const sessionDir = path.join(outside, "session");
		const policyPath = path.join(outside, "policy.json");
		fs.writeFileSync(
			policyPath,
			JSON.stringify({
				owner: OWNER,
				allowlist: [],
				workdir: work,
				auditLog: path.join(outside, "audit.jsonl"),
				omp: { command: ["bun", path.join(PACKAGE, "test", "fake-omp.ts")], model: "fake/model", tools: ["read"], sessionDir },
			}),
		);
		await expect(Bridge.start({ policyPath, chat: new SimulatedChat() })).rejects.toBeInstanceOf(PolicyError);
		expect(fs.existsSync(path.join(sessionDir, "launch.json"))).toBe(false);
	});
});

describe("forwarding (AC-4)", () => {
	it("sends a pasted RPC bash frame as the text of one prompt", async () => {
		const f = await bridgeFixture();
		const raw = JSON.stringify({ type: "bash", command: "echo direct-bash > direct-bash.txt" });
		expect(await f.chat.say(TEAMMATE, raw)).toMatchObject({ forwarded: true });
		await turnEnded(f);
		expect(f.stdinFrames()).toEqual([expect.objectContaining({ type: "prompt", message: raw })]);
		expectOnlyPromptsAndAnswers(f);
	});
});

describe("owner-only approval (AC-5)", () => {
	it("asks the owner alone, with the requester, the channel text, the full arguments, and a deadline", async () => {
		const f = await bridgeFixture({ policy: { ownerTimeoutMs: 60_000 } });
		const text = bashApproval("echo probe > model-bash.txt", { cwd: "/srv/shop", timeout: 30 });
		const sent = await f.chat.say(TEAMMATE, text);
		const before = Date.now();
		const q = await question(f);
		expect(f.chat.ownerQuestions).toHaveLength(1);
		expect(f.chat.ownerQuestions[0]!.to).toBe(OWNER);
		expect(q).toMatchObject({
			toolCallId: "T1",
			requester: TEAMMATE,
			requestText: text,
			messageId: sent.messageId,
			tool: "bash",
			args: { command: "echo probe > model-bash.txt", cwd: "/srv/shop", timeout: 30 },
		});
		expect(q.ompTitle).toBe("Allow tool: bash\nCommand: echo probe > model-bash.txt");
		expect(Math.abs(Date.parse(q.deadline) - (before + 60_000))).toBeLessThan(1_500);
		expect(q.questionId.length).toBeGreaterThanOrEqual(16);
		await f.chat.answer(OWNER, q.questionId, "Deny");
		await turnEnded(f);
	});

	it("sends the owner's Approve to omp exactly once", async () => {
		const f = await bridgeFixture();
		await f.chat.say(TEAMMATE, bashApproval("echo probe > model-bash.txt"));
		const q = await question(f);
		await f.chat.answer(OWNER, q.questionId, "Approve");
		await turnEnded(f);
		await f.chat.answer(OWNER, q.questionId, "Approve");
		await Bun.sleep(100);
		expect(f.responses()).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Approve" }]);
		expect(f.audit().filter(e => e.event === "answer_ignored")).toEqual([
			expect.objectContaining({ questionId: q.questionId, from: OWNER, reason: "unknown or settled question" }),
		]);
		expectOnlyPromptsAndAnswers(f);
	});

	it("ignores an answer from anyone but the owner, and an answer to an unknown question", async () => {
		const f = await bridgeFixture();
		await f.chat.say(TEAMMATE, bashApproval("echo probe > model-bash.txt"));
		const q = await question(f);
		await f.chat.answer(TEAMMATE, q.questionId, "Approve");
		await f.chat.answer(OWNER, "not-a-question", "Approve");
		await Bun.sleep(100);
		expect(f.responses()).toEqual([]);
		const ignored = f.audit().filter(e => e.event === "answer_ignored");
		expect(ignored).toEqual([
			expect.objectContaining({ from: TEAMMATE, reason: "not the owner" }),
			expect.objectContaining({ from: OWNER, reason: "unknown or settled question" }),
		]);
		await f.chat.answer(OWNER, q.questionId, "Deny");
		await turnEnded(f);
		expect(f.responses()).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Deny" }]);
	});

	it("answers Deny when the owner does not answer in time, and tells the requester", async () => {
		const f = await bridgeFixture({ policy: { ownerTimeoutMs: 400 } });
		await f.chat.say(TEAMMATE, bashApproval("echo probe > model-bash.txt"));
		await question(f);
		await turnEnded(f);
		expect(f.responses()).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Deny" }]);
		const notice = f.chat.channelPosts.find(post => post.text.includes("did not answer"));
		expect(notice?.text).toContain(TEAMMATE);
		expect(f.audit().find(e => e.event === "question_settled")).toMatchObject({ answer: "Deny", timedOut: true, answeredBy: null });
	});

	const unbound: Array<[string, object[]]> = [
		["has no tool call to belong to", [{ ask: { method: "select", title: "Allow tool: bash\nCommand: echo a", options: ["Approve", "Deny"] } }]],
		[
			"could belong to either of two pending calls",
			[
				{ start: { toolCallId: "T1", toolName: "bash", args: { command: "echo a" } } },
				{ start: { toolCallId: "T2", toolName: "bash", args: { command: "echo a" } } },
				{ ask: { method: "select", title: "Allow tool: bash\nCommand: echo a", options: ["Approve", "Deny"] } },
			],
		],
		[
			"shows a command the pending call does not run",
			[
				{ start: { toolCallId: "T1", toolName: "bash", args: { command: "echo a" } } },
				{ ask: { method: "select", title: "Allow tool: bash\nCommand: echo b", options: ["Approve", "Deny"] } },
			],
		],
	];
	for (const [name, steps] of unbound) {
		it(`answers Deny without asking anyone when the question ${name}`, async () => {
			const f = await bridgeFixture();
			await f.chat.say(TEAMMATE, script({ steps }));
			await turnEnded(f);
			expect(f.chat.ownerQuestions).toEqual([]);
			expect(f.responses()).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Deny" }]);
			expect(f.audit().find(e => e.event === "question_settled")).toMatchObject({ bound: false, answer: "Deny" });
		});
	}

	it("waits briefly for a tool call that is reported after its question", async () => {
		const f = await bridgeFixture({ bindWaitMs: 1_000 });
		await f.chat.say(
			TEAMMATE,
			script({
				steps: [
					{ ask: { method: "select", title: "Allow tool: bash\nCommand: echo late", options: ["Approve", "Deny"], wait: false } },
					{ sleep: 150 },
					{ start: { toolCallId: "T9", toolName: "bash", args: { command: "echo late" } } },
					{ waitAll: true },
				],
			}),
		);
		const q = await question(f);
		expect(q.toolCallId).toBe("T9");
		await f.chat.answer(OWNER, q.questionId, "Approve");
		await turnEnded(f);
		expect(f.responses()).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Approve" }]);
	});

	it("cancels confirm, input, editor, and any select that is not a tool approval", async () => {
		const f = await bridgeFixture();
		await f.chat.say(
			TEAMMATE,
			script({
				steps: [
					{ ask: { method: "confirm", title: "Continue?" } },
					{ ask: { method: "input", title: "Branch name" } },
					{ ask: { method: "editor", title: "Edit the message" } },
					{ ask: { method: "select", title: "Which colour?", options: ["red", "blue"] } },
				],
			}),
		);
		await turnEnded(f);
		expect(f.chat.ownerQuestions).toEqual([]);
		expect(f.responses()).toEqual(
			["ui-1", "ui-2", "ui-3", "ui-4"].map(id => ({ type: "extension_ui_response", id, cancelled: true })),
		);
	});

	it("closes the question when omp cancels it, so a later answer is ignored", async () => {
		const f = await bridgeFixture();
		await f.chat.say(
			TEAMMATE,
			script({
				steps: [
					{ start: { toolCallId: "T1", toolName: "bash", args: { command: "echo a" } } },
					{ ask: { method: "select", title: "Allow tool: bash\nCommand: echo a", options: ["Approve", "Deny"], label: "q", wait: false } },
					{ sleep: 200 },
					{ cancel: "q" },
					{ waitAll: true },
				],
			}),
		);
		const q = await question(f);
		await turnEnded(f);
		await f.chat.answer(OWNER, q.questionId, "Approve");
		await Bun.sleep(100);
		expect(f.responses()).toEqual([]);
		expect(f.audit().find(e => e.event === "question_settled")).toMatchObject({ questionId: q.questionId, answer: "cancelled" });
	});
});

describe("report and record (AC-6)", () => {
	it("posts the final reply under the request and records the message and the question", async () => {
		const f = await bridgeFixture();
		const text = bashApproval("echo probe > model-bash.txt", { cwd: "/srv/shop" });
		const sent = await f.chat.say(TEAMMATE, text);
		const q = await question(f);
		await f.chat.answer(OWNER, q.questionId, "Approve");
		await turnEnded(f);
		const reply = f.chat.channelPosts.find(post => post.replyTo === sent.messageId);
		expect(reply?.text).toContain("Approve");

		const audit = f.audit();
		expect(audit.find(e => e.event === "message")).toMatchObject({
			from: TEAMMATE,
			messageId: sent.messageId,
			text,
			forwarded: true,
		});
		expect(audit.find(e => e.event === "question_asked")).toMatchObject({
			questionId: q.questionId,
			toolCallId: "T1",
			tool: "bash",
			args: { command: "echo probe > model-bash.txt", cwd: "/srv/shop" },
			requester: TEAMMATE,
			owner: OWNER,
			deadline: q.deadline,
		});
		expect(audit.find(e => e.event === "question_settled")).toMatchObject({
			questionId: q.questionId,
			answer: "Approve",
			answeredBy: OWNER,
			timedOut: false,
			bound: true,
		});
		for (const entry of audit) expect(typeof entry.ts).toBe("string");
	});

	it("posts a failed request's error to the requester", async () => {
		const f = await bridgeFixture();
		const sent = await f.chat.say(TEAMMATE, script({ fail: "model not available" }));
		const post = await waitFor(() => f.chat.channelPosts.find(p => p.text.includes("model not available")), 10_000, "error post");
		expect(post.replyTo).toBe(sent.messageId);
		expect(await f.chat.say(TEAMMATE, "next")).toMatchObject({ forwarded: true });
	});

	it("stops forwarding when omp exits", async () => {
		const f = await bridgeFixture();
		await f.chat.say(TEAMMATE, script({ steps: [{ exit: 3 }] }));
		await waitFor(() => f.audit().some(e => e.event === "omp_exit"), 10_000, "omp exit");
		expect(await f.chat.say(TEAMMATE, "are you there?")).toMatchObject({ forwarded: false, reason: "omp not running" });
	});
});

describe("startup isolation (AC-7)", () => {
	it("starts omp in RPC mode with the locked flags, the generated config, and only the named variables", async () => {
		const f = await bridgeFixture({
			omp: { env: ["CURSOR_API_KEY"] },
			baseEnv: { ...process.env, CURSOR_API_KEY: "model-key", REMOTE_COMMAND_TEST_SECRET: "bridge-only" },
		});
		const launch = JSON.parse(fs.readFileSync(path.join(f.sessionDir, "launch.json"), "utf8")) as {
			argv: string[];
			env: Record<string, string>;
		};
		const flag = (name: string) => launch.argv[launch.argv.indexOf(name) + 1];
		expect(flag("--mode")).toBe("rpc");
		expect(flag("--approval-mode")).toBe("always-ask");
		expect(flag("--tools")).toBe("read,bash");
		expect(flag("-e")).toBe(PACKAGE);
		expect(launch.argv).toContain("--no-extensions");

		const config = Bun.YAML.parse(fs.readFileSync(flag("--config")!, "utf8")) as Record<string, Record<string, unknown>>;
		expect(config.tools?.approvalMode).toBe("always-ask");
		expect(config.collab?.autoStart).toBe("off");
		expect(Object.values(config.tools?.approval as Record<string, string>).every(v => v === "prompt" || v === "deny")).toBe(true);

		const allowed = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "CURSOR_API_KEY"]);
		for (const name of Object.keys(launch.env)) expect(allowed).toContain(name);
		expect(launch.env.CURSOR_API_KEY).toBe("model-key");
		expect(launch.env.REMOTE_COMMAND_TEST_SECRET).toBeUndefined();
	});
});
