// The part of the remote-command workflow that runs outside omp. omp trusts whatever writes to its
// stdin, so the bridge is the trust boundary. It starts omp as its child over stdio and:
//   ① forwards only messages from allowlisted platform user IDs, never a slash command, one at a time;
//   ② writes only a `prompt` with the message as its text, and answers to dialogs;
//   ③ binds each tool approval to the one tool call omp reported before asking, puts it to the owner
//      alone with the call's full arguments and a deadline, accepts only the owner's first answer to
//      that question, and answers Deny at the deadline; every other dialog is cancelled;
//   ⑤ posts the reply back under the request and writes an audit log.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import type { ChannelMessage, ChatAdapter, ForwardResult, OwnerAnswer, OwnerQuestion } from "./chat";
import { type Policy, PolicyError, loadPolicy, ompLaunch, renderOmpConfig } from "./policy";

type Frame = Record<string, unknown>;
type Answer = "Approve" | "Deny";
type Outbound =
	| { type: "prompt"; message: string }
	| { type: "extension_ui_response"; id: string; value: Answer }
	| { type: "extension_ui_response"; id: string; cancelled: true };

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const OUTBOUND_TYPES = new Set(["prompt", "extension_ui_response"]);
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const APPROVAL_TITLE = "Allow tool: ";
const COMMAND_LINE = "\nCommand: ";
/** omp shows at most this many characters of a command in its question. */
const TITLE_DETAIL_CHARS = 2000;

export interface BridgeOptions {
	policyPath: string;
	chat: ChatAdapter;
	/** This package's folder, loaded into omp with -e. */
	extensionDir?: string;
	/** How long a tool approval waits for omp to report its tool call. */
	bindWaitMs?: number;
	readyTimeoutMs?: number;
	/** Every frame omp writes, for the caller's own records. */
	onFrame?: (frame: Frame) => void;
	/** Where omp's environment is picked from; defaults to process.env. */
	baseEnv?: Record<string, string | undefined>;
}

interface Turn {
	requester: string;
	channelId: string;
	messageId: string;
	text: string;
}

interface OpenCall {
	toolName: string;
	args: unknown;
	bound: boolean;
}

interface Question {
	ompId: string;
	owner: string;
	toolCallId: string;
	tool: string;
	turn: Turn;
	timer: Timer;
}

interface Outcome {
	answer: Answer | "cancelled" | "closed";
	answeredBy: string | null;
	timedOut: boolean;
	reason?: string;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function mention(userId: string): string {
	return `<@${userId}>`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** omp's question for a bash call must show the command that call runs. */
function titleMatchesArgs(tool: string, title: string, args: unknown): boolean {
	if (tool !== "bash") return true;
	const command = typeof args === "object" && args !== null ? (args as { command?: unknown }).command : undefined;
	const at = title.indexOf(COMMAND_LINE);
	if (typeof command !== "string" || at < 0) return false;
	const shown = title.slice(at + COMMAND_LINE.length);
	return command.length <= TITLE_DETAIL_CHARS ? shown === command : shown.startsWith(command.slice(0, TITLE_DETAIL_CHARS));
}

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; content?: unknown };
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = (message.content as Array<{ type?: unknown; text?: unknown }>)
			.filter(block => block?.type === "text" && typeof block.text === "string")
			.map(block => block.text as string)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

export class Bridge {
	#options: BridgeOptions;
	#chat: ChatAdapter;
	#policy: Policy;
	#auditLog: string;
	#child: Subprocess<"pipe", "pipe", "pipe">;
	#configDir: string;
	#bindWaitMs: number;
	#turn: Turn | undefined;
	#open = new Map<string, OpenCall>();
	#startWatchers = new Set<() => void>();
	#questions = new Map<string, Question>();
	#questionByOmpId = new Map<string, string>();
	#nextPromptId = 1;
	#ready = Promise.withResolvers<void>();
	#exited = false;
	#stopping = false;
	#stderrTail = "";

	/** Use Bridge.start. */
	constructor(options: BridgeOptions, policy: Policy, child: Subprocess<"pipe", "pipe", "pipe">, configDir: string) {
		this.#options = options;
		this.#chat = options.chat;
		this.#policy = policy;
		this.#auditLog = policy.auditLog;
		this.#child = child;
		this.#configDir = configDir;
		this.#bindWaitMs = options.bindWaitMs ?? 2_000;
		void this.#readStdout();
		void this.#readStderr();
		void child.exited.then(code => this.#onExit(code));
	}

	/** Validates the policy, starts omp, waits until it is ready, then starts the chat adapter. */
	static async start(options: BridgeOptions): Promise<Bridge> {
		const policy = await loadPolicy(options.policyPath);
		if (!fs.statSync(policy.workdir, { throwIfNoEntry: false })?.isDirectory()) {
			throw new PolicyError([`workdir ${policy.workdir} is not a directory`]);
		}
		fs.mkdirSync(path.dirname(policy.auditLog), { recursive: true });
		fs.appendFileSync(policy.auditLog, "");
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-remote-command-"));
		const configPath = path.join(configDir, "config.yml");
		fs.writeFileSync(configPath, renderOmpConfig(policy), { mode: 0o600 });
		const { argv, env } = ompLaunch(policy, {
			extensionDir: options.extensionDir ?? PACKAGE_DIR,
			configPath,
			baseEnv: options.baseEnv,
		});
		const child = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const bridge = new Bridge(options, policy, child, configDir);
		try {
			await bridge.#waitReady(options.readyTimeoutMs ?? 60_000);
		} catch (err) {
			await bridge.stop();
			throw err;
		}
		bridge.#record({
			event: "start",
			argv,
			envNames: Object.keys(env).sort(),
			owner: policy.owner,
			allowlist: policy.allowlist.length,
			tools: policy.omp.tools,
		});
		await options.chat.start({
			onChannelMessage: message => bridge.#onChannelMessage(message),
			onOwnerAnswer: answer => bridge.#onOwnerAnswer(answer),
		});
		return bridge;
	}

	get exited(): boolean {
		return this.#exited;
	}

	/** Resolves once no request is running. */
	async whenIdle(timeoutMs = 300_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.#turn && !this.#exited) {
			if (Date.now() > deadline) throw new Error("the request is still running");
			await Bun.sleep(50);
		}
	}

	async stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		for (const question of this.#questions.values()) clearTimeout(question.timer);
		try {
			this.#child.stdin.end();
		} catch {}
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => resolve(false), 15_000);
		void this.#child.exited.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
		if (!(await promise)) {
			this.#child.kill("SIGKILL");
			await this.#child.exited;
		}
		await this.#chat.stop();
		fs.rmSync(this.#configDir, { recursive: true, force: true });
	}

	// ① entry

	async #onChannelMessage(message: ChannelMessage): Promise<ForwardResult> {
		const result = await this.#admit(message);
		this.#record({
			event: "message",
			from: message.userId,
			channel: message.channelId,
			messageId: message.messageId,
			text: message.text,
			forwarded: result.forwarded,
			...(result.reason ? { reason: result.reason } : {}),
		});
		return result;
	}

	async #admit(message: ChannelMessage): Promise<ForwardResult> {
		try {
			this.#policy = await loadPolicy(this.#options.policyPath);
		} catch {
			return { forwarded: false, reason: "policy unreadable or invalid" };
		}
		if (!this.#policy.allowlist.includes(message.userId)) return { forwarded: false, reason: "sender not on allowlist" };
		if (message.text.trimStart().startsWith("/")) return { forwarded: false, reason: "slash command" };
		if (this.#exited) return { forwarded: false, reason: "omp not running" };
		if (this.#turn) return { forwarded: false, reason: "agent busy" };
		this.#turn = { requester: message.userId, channelId: message.channelId, messageId: message.messageId, text: message.text };
		// ② the message is only ever the text of a prompt, even when it looks like an RPC frame.
		this.#send({ type: "prompt", message: message.text });
		return { forwarded: true };
	}

	// ② the only writer to omp's stdin

	#send(frame: Outbound): void {
		if (!OUTBOUND_TYPES.has(frame.type)) throw new Error(`refusing to send ${frame.type} to omp`);
		if (this.#exited) return;
		const line = frame.type === "prompt" ? { id: `rc-${this.#nextPromptId++}`, ...frame } : frame;
		this.#child.stdin.write(`${JSON.stringify(line)}\n`);
		this.#child.stdin.flush();
	}

	// omp's output

	async #readStdout(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.#child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					continue;
				}
				this.#onFrame(frame);
			}
		}
	}

	async #readStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#child.stderr) {
			this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-4_000);
		}
	}

	#onFrame(frame: Frame): void {
		this.#options.onFrame?.(frame);
		switch (frame.type) {
			case "ready":
				this.#ready.resolve();
				break;
			case "tool_execution_start": {
				const toolCallId = str(frame.toolCallId);
				if (!toolCallId) break;
				this.#open.set(toolCallId, { toolName: str(frame.toolName), args: frame.args, bound: false });
				for (const watcher of [...this.#startWatchers]) watcher();
				break;
			}
			case "tool_execution_end":
				this.#open.delete(str(frame.toolCallId));
				break;
			case "extension_ui_request":
				void this.#onDialog(frame);
				break;
			case "agent_end":
				if (frame.isTerminal !== false) this.#endTurn(lastAssistantText(frame.messages));
				break;
			case "response":
				if (frame.command !== "prompt") break;
				if (frame.success === false) this.#endTurn(undefined, str(frame.error) || "unknown error");
				else if ((frame.data as { agentInvoked?: unknown } | undefined)?.agentInvoked === false) this.#endTurn("");
				break;
			case "prompt_result":
				if (frame.agentInvoked === false) this.#endTurn("");
				break;
			case "extension_error":
				this.#record({ event: "extension_error", extensionPath: frame.extensionPath, hook: frame.event, error: frame.error });
				break;
		}
	}

	// ③ before action

	async #onDialog(frame: Frame): Promise<void> {
		const method = str(frame.method);
		const id = str(frame.id);
		if (method === "cancel") {
			const questionId = this.#questionByOmpId.get(str(frame.targetId));
			if (questionId) this.#settle(questionId, { answer: "cancelled", answeredBy: null, timedOut: false, reason: "omp withdrew the question" });
			return;
		}
		if (method === "notify") {
			this.#record({ event: "omp_notice", message: str(frame.message) });
			return;
		}
		if (!DIALOG_METHODS.has(method)) return;
		const title = str(frame.title);
		if (method === "select" && title.startsWith(APPROVAL_TITLE)) {
			await this.#onApproval(id, title);
			return;
		}
		// Only the owner may answer omp, and only tool approvals are the owner's to answer.
		this.#send({ type: "extension_ui_response", id, cancelled: true });
		this.#record({ event: "dialog_cancelled", method, title });
	}

	/** The single open, unbound tool call of `tool`, or "ambiguous" when there is more than one. */
	#bindable(tool: string): [string, OpenCall] | "ambiguous" | undefined {
		const matches = [...this.#open].filter(([, call]) => call.toolName === tool && !call.bound);
		if (matches.length === 0) return undefined;
		return matches.length === 1 ? matches[0] : "ambiguous";
	}

	#waitForCall(tool: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const done = () => {
			clearTimeout(timer);
			this.#startWatchers.delete(watch);
			resolve();
		};
		const watch = () => {
			if (this.#bindable(tool) !== undefined) done();
		};
		const timer = setTimeout(done, this.#bindWaitMs);
		this.#startWatchers.add(watch);
		return promise;
	}

	async #onApproval(ompId: string, title: string): Promise<void> {
		const tool = (title.slice(APPROVAL_TITLE.length).split("\n", 1)[0] ?? "").trim();
		let call = this.#bindable(tool);
		if (call === undefined) {
			await this.#waitForCall(tool);
			call = this.#bindable(tool);
		}
		const turn = this.#turn;
		const unbound = !turn
			? "no request is running"
			: call === undefined
				? "no tool call to match"
				: call === "ambiguous"
					? "more than one tool call could match"
					: !titleMatchesArgs(tool, title, call[1].args)
						? "the question does not show the tool call's command"
						: undefined;
		if (unbound || !turn || !call || call === "ambiguous") {
			this.#send({ type: "extension_ui_response", id: ompId, value: "Deny" });
			this.#record({
				event: "question_settled",
				questionId: crypto.randomUUID(),
				ompRequestId: ompId,
				tool,
				answer: "Deny",
				answeredBy: null,
				timedOut: false,
				bound: false,
				reason: unbound,
			});
			if (turn) {
				void this.#post(turn.channelId, `${mention(turn.requester)} a ${tool} call could not be matched to its approval question, so it was denied.`, turn.messageId);
			}
			return;
		}

		const [toolCallId, open] = call;
		open.bound = true;
		const owner = this.#policy.owner;
		const timeoutMs = this.#policy.ownerTimeoutMs;
		const questionId = crypto.randomUUID();
		const deadline = new Date(Date.now() + timeoutMs).toISOString();
		const timer = setTimeout(() => this.#settle(questionId, { answer: "Deny", answeredBy: null, timedOut: true }), timeoutMs);
		this.#questions.set(questionId, { ompId, owner, toolCallId, tool, turn, timer });
		this.#questionByOmpId.set(ompId, questionId);
		const question: OwnerQuestion = {
			questionId,
			toolCallId,
			requester: turn.requester,
			channelId: turn.channelId,
			messageId: turn.messageId,
			requestText: turn.text,
			tool,
			args: open.args,
			ompTitle: title,
			deadline,
		};
		this.#record({
			event: "question_asked",
			questionId,
			ompRequestId: ompId,
			toolCallId,
			tool,
			args: open.args,
			requester: turn.requester,
			requestText: turn.text,
			owner,
			deadline,
		});
		try {
			await this.#chat.askOwner(owner, question);
		} catch (err) {
			this.#settle(questionId, { answer: "Deny", answeredBy: null, timedOut: false, reason: `the question could not be delivered: ${errorText(err)}` });
		}
	}

	async #onOwnerAnswer(answer: OwnerAnswer): Promise<void> {
		const question = this.#questions.get(answer.questionId);
		const ignore = (reason: string) =>
			this.#record({ event: "answer_ignored", questionId: answer.questionId, from: answer.userId, answer: answer.answer, reason });
		if (!question) return ignore("unknown or settled question");
		if (answer.userId !== question.owner) return ignore("not the owner");
		if (answer.answer !== "Approve" && answer.answer !== "Deny") return ignore("not Approve or Deny");
		this.#settle(answer.questionId, { answer: answer.answer, answeredBy: answer.userId, timedOut: false });
	}

	#settle(questionId: string, outcome: Outcome): void {
		const question = this.#questions.get(questionId);
		if (!question) return;
		this.#questions.delete(questionId);
		this.#questionByOmpId.delete(question.ompId);
		clearTimeout(question.timer);
		if (outcome.answer === "Approve" || outcome.answer === "Deny") {
			this.#send({ type: "extension_ui_response", id: question.ompId, value: outcome.answer });
		}
		this.#record({
			event: "question_settled",
			questionId,
			ompRequestId: question.ompId,
			toolCallId: question.toolCallId,
			tool: question.tool,
			answer: outcome.answer,
			answeredBy: outcome.answeredBy,
			timedOut: outcome.timedOut,
			bound: true,
			...(outcome.reason ? { reason: outcome.reason } : {}),
		});
		if (outcome.timedOut) {
			const { channelId, requester, messageId } = question.turn;
			void this.#post(channelId, `${mention(requester)} the owner did not answer in time, so this was not done.`, messageId);
		}
	}

	// ⑤ report and record

	#endTurn(reply: string | undefined, error?: string): void {
		const turn = this.#turn;
		if (!turn) return;
		this.#turn = undefined;
		this.#open.clear();
		const text = error !== undefined ? `${mention(turn.requester)} the request failed: ${error}` : reply;
		if (text) void this.#post(turn.channelId, text, turn.messageId);
		this.#record({
			event: "turn_end",
			requester: turn.requester,
			messageId: turn.messageId,
			...(error !== undefined ? { error } : { reply: reply ?? "" }),
		});
	}

	#onExit(code: number | null): void {
		this.#exited = true;
		this.#ready.reject(new Error(`omp exited before it was ready (code ${code}): ${this.#stderrTail.trim()}`));
		this.#record({ event: "omp_exit", code });
		for (const questionId of [...this.#questions.keys()]) {
			this.#settle(questionId, { answer: "closed", answeredBy: null, timedOut: false, reason: "omp exited" });
		}
		const turn = this.#turn;
		this.#turn = undefined;
		if (turn && !this.#stopping) {
			void this.#post(turn.channelId, `${mention(turn.requester)} omp stopped before finishing this request.`, turn.messageId);
		}
	}

	async #waitReady(timeoutMs: number): Promise<void> {
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeout.reject(new Error(`omp was not ready within ${timeoutMs} ms: ${this.#stderrTail.trim()}`)),
			timeoutMs,
		);
		try {
			await Promise.race([this.#ready.promise, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	async #post(channelId: string, text: string, replyTo: string): Promise<void> {
		try {
			await this.#chat.postToChannel(channelId, text, replyTo);
		} catch (err) {
			this.#record({ event: "post_failed", channel: channelId, error: errorText(err) });
		}
	}

	#record(entry: Record<string, unknown>): void {
		try {
			fs.appendFileSync(this.#auditLog, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
		} catch (err) {
			process.stderr.write(`omp-remote-command: could not write the audit log: ${errorText(err)}\n`);
		}
	}
}
