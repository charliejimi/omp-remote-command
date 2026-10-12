import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startupProblems } from "../src/index";
import { closeRegistry, initSettings, loadExtension, removeTemps, tempDir } from "./helpers";

afterEach(() => {
	resetSettingsForTest();
	removeTemps();
});
afterAll(closeRegistry);

async function loaded(overrides: Record<string, unknown> = {}) {
	const cwd = tempDir("rc-ext-");
	await initSettings(cwd, overrides);
	return loadExtension(cwd);
}

describe("RPC bash side door (AC-1)", () => {
	it("answers any other command with exit code 126 instead of running it", async () => {
		const { userBash, handlerErrors } = await loaded();
		const result = await userBash("echo x > marker");
		expect(result?.result?.exitCode).toBe(126);
		expect(result?.result?.output).toContain("echo x > marker");
		expect(handlerErrors).toEqual([]);
	});

	it("lets the two read-only git commands through", async () => {
		const { userBash } = await loaded();
		expect(await userBash("git status --short")).toBeUndefined();
		expect(await userBash("  git log --oneline -5  ")).toBeUndefined();
	});

	it("refuses a command it cannot read instead of throwing, because a throw would let omp run it", async () => {
		const { userBash, handlerErrors } = await loaded();
		const result = await userBash(42);
		expect(result?.result?.exitCode).toBe(126);
		expect(handlerErrors).toEqual([]);
	});

	it("refuses a near miss of an allowed command", async () => {
		const { userBash } = await loaded();
		expect((await userBash("git status --short; rm -rf src"))?.result?.exitCode).toBe(126);
	});
});

describe("startup lock (AC-2)", () => {
	it("blocks nothing when omp runs always-ask, with no allow rule and collab off", async () => {
		const { toolCall } = await loaded();
		expect(await toolCall("bash", { command: "ls" })).toBeUndefined();
	});

	const unsafe: Array<[string, Record<string, unknown>, string]> = [
		["approval mode write", { "tools.approvalMode": "write" }, "tools.approvalMode"],
		["approval mode yolo", { "tools.approvalMode": "yolo" }, "tools.approvalMode"],
		["a per-tool allow rule", { "tools.approval": { bash: "Allow" } }, "tools.approval.bash"],
		["a bash pattern that allows", { "bash.patterns": [{ match: "git push*", approval: "allow" }] }, "bash.patterns"],
		["collab started for every session", { "collab.autoStart": "view" }, "collab.autoStart"],
	];
	for (const [name, overrides, named] of unsafe) {
		it(`blocks every tool call with ${name}, naming ${named}`, async () => {
			const { toolCall } = await loaded(overrides);
			const result = await toolCall("read", { path: "README.md" });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain(named);
		});
	}

	it("names the yolo flags on the command line", () => {
		const remoteReady = (key: string) =>
			({ "tools.approvalMode": "always-ask", "tools.approval": {}, "bash.patterns": [], "collab.autoStart": "off" })[key];
		expect(startupProblems(remoteReady, ["--mode", "rpc"])).toEqual([]);
		expect(startupProblems(remoteReady, ["--mode", "rpc", "--yolo"]).join("\n")).toContain("--yolo");
		expect(startupProblems(remoteReady, ["--auto-approve"]).join("\n")).toContain("--auto-approve");
	});

	it("fails closed when the settings cannot be read", () => {
		const unreadable = () => {
			throw new Error("Settings not initialized");
		};
		expect(startupProblems(unreadable, []).length).toBeGreaterThan(0);
	});
});
