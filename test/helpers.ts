import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Bridge } from "../src/bridge";
import { SimulatedChat } from "../src/chat";

export const PACKAGE = path.resolve(import.meta.dir, "..");
export const FAKE_OMP = path.join(import.meta.dir, "fake-omp.ts");
export const OWNER = "U_OWNER";
export const TEAMMATE = "U_TEAMMATE";
export const OUTSIDER = "U_CONTRACTOR";

const temps: string[] = [];

export function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

export function removeTemps(): void {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function readJsonl(file: string): Record<string, unknown>[] {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

export async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000, what = "condition"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	fs.rmSync(registry.dir, { recursive: true, force: true });
	registry = undefined;
}

/** omp's global settings as the bridge launches them, with any key overridden by the test. */
export async function initSettings(cwd: string, overrides: Record<string, unknown> = {}): Promise<Settings> {
	resetSettingsForTest();
	return Settings.init({
		inMemory: true,
		cwd,
		overrides: { "tools.approvalMode": "always-ask", "collab.autoStart": "off", ...overrides },
	});
}

/** Loads the package through omp's own loader and runner and starts the session. */
export async function loadExtension(cwd: string) {
	const result = await discoverAndLoadExtensions([PACKAGE], cwd, undefined, undefined, { ambient: false });
	const extensions = result.extensions.filter(e => e.path.startsWith(PACKAGE));
	const loadErrors = result.errors.filter(e => e.path.startsWith(PACKAGE));
	if (loadErrors.length > 0 || extensions.length !== 1) {
		throw new Error(`package did not load: ${JSON.stringify(loadErrors)} (${extensions.length} extensions)`);
	}
	const runner = new ExtensionRunner(extensions, result.runtime, cwd, SessionManager.inMemory(cwd), await models());
	const handlerErrors: string[] = [];
	runner.onError(e => handlerErrors.push(`${e.event}: ${e.error}`));
	await runner.emit({ type: "session_start" });
	const userBash = (command: unknown) =>
		runner.emitUserBash({ type: "user_bash", command: command as string, excludeFromContext: false, cwd });
	const toolCall = (toolName: string, input: Record<string, unknown>) =>
		runner.emitToolCall({ type: "tool_call", toolCallId: "call-1", toolName, input } as never);
	return { runner, handlerErrors, userBash, toolCall };
}

/** A prompt the fake child plays as a script of RPC frames. */
export function script(body: object): string {
	return `SCRIPT:${JSON.stringify(body)}`;
}

/** The fake child asks for one bash approval, as omp does for a model's shell call. */
export function bashApproval(command: string, args: Record<string, unknown> = {}, toolCallId = "T1"): string {
	return script({
		steps: [
			{ start: { toolCallId, toolName: "bash", args: { command, ...args } } },
			{ ask: { method: "select", title: `Allow tool: bash\nCommand: ${command}`, options: ["Approve", "Deny"] } },
			{ end: { toolCallId, toolName: "bash", text: "finished" } },
		],
	});
}

export interface BridgeFixtureOptions {
	policy?: Record<string, unknown>;
	omp?: Record<string, unknown>;
	bindWaitMs?: number;
	baseEnv?: Record<string, string | undefined>;
}

const bridges: Bridge[] = [];

export async function stopBridges(): Promise<void> {
	for (const bridge of bridges.splice(0)) await bridge.stop();
}

/** A policy file outside the work tree and a bridge running the fake omp child. */
export async function bridgeFixture(options: BridgeFixtureOptions = {}) {
	const work = tempDir("rc-work-");
	const outside = tempDir("rc-outside-");
	const sessionDir = path.join(outside, "session");
	const auditLog = path.join(outside, "audit.jsonl");
	const policy = {
		owner: OWNER,
		allowlist: [OWNER, TEAMMATE],
		ownerTimeoutMs: 5_000,
		workdir: work,
		auditLog,
		...options.policy,
		omp: {
			command: ["bun", FAKE_OMP],
			model: "fake/model",
			tools: ["read", "bash"],
			sessionDir,
			...options.omp,
		},
	};
	const policyPath = path.join(outside, "policy.json");
	fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
	const chat = new SimulatedChat();
	const bridge = await Bridge.start({
		policyPath,
		chat,
		bindWaitMs: options.bindWaitMs ?? 300,
		baseEnv: options.baseEnv,
	});
	bridges.push(bridge);
	const stdinFrames = () => readJsonl(path.join(sessionDir, "stdin.jsonl"));
	const responses = () => stdinFrames().filter(f => f.type === "extension_ui_response");
	const audit = () => readJsonl(auditLog);
	return { work, outside, sessionDir, auditLog, policy, policyPath, chat, bridge, stdinFrames, responses, audit };
}
