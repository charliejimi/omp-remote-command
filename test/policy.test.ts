import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PolicyError, loadPolicy, ompLaunch, parsePolicy, renderOmpConfig } from "../src/policy";
import { PACKAGE, removeTemps, tempDir } from "./helpers";

afterEach(removeTemps);

function layout() {
	const work = tempDir("rc-policy-work-");
	const outside = tempDir("rc-policy-outside-");
	const policyFile = path.join(outside, "policy.json");
	const valid = {
		owner: "U_OWNER",
		allowlist: ["U_OWNER", "U_TEAMMATE"],
		workdir: work,
		auditLog: path.join(outside, "audit.jsonl"),
		omp: { command: ["omp"], model: "cursor-sdk/claude-opus-5-5", tools: ["read", "bash"] },
	};
	return { work, outside, policyFile, valid };
}

function problemsOf(raw: unknown, file: string): string[] {
	try {
		parsePolicy(raw, file);
	} catch (err) {
		if (err instanceof PolicyError) return err.problems;
		throw err;
	}
	return [];
}

describe("policy validation (AC-3, start time)", () => {
	it("accepts a valid policy and fills in the defaults", () => {
		const { policyFile, valid } = layout();
		const policy = parsePolicy(valid, policyFile);
		expect(policy.ownerTimeoutMs).toBe(120_000);
		expect(policy.omp.toolRules).toEqual({ bash: "prompt" });
		expect(policy.omp.bashPatterns).toEqual([]);
		expect(policy.omp.env).toEqual([]);
	});

	const faults: Array<[string, (p: ReturnType<typeof layout>) => unknown, string]> = [
		["an empty allowlist", p => ({ ...p.valid, allowlist: [] }), "allowlist"],
		["a wildcard in the allowlist", p => ({ ...p.valid, allowlist: ["U_OWNER", "*"] }), "allowlist"],
		["no owner", p => ({ ...p.valid, owner: "" }), "owner"],
		["a wildcard owner", p => ({ ...p.valid, owner: "*" }), "owner"],
		["an allow tool rule", p => ({ ...p.valid, omp: { ...p.valid.omp, toolRules: { bash: "allow" } } }), "toolRules.bash"],
		[
			"an allow bash pattern",
			p => ({ ...p.valid, omp: { ...p.valid.omp, bashPatterns: [{ match: "git push*", approval: "allow" }] } }),
			"bashPatterns",
		],
		["an audit log inside the work tree", p => ({ ...p.valid, auditLog: path.join(p.work, "audit.jsonl") }), "auditLog"],
		[
			"a session directory inside the work tree",
			p => ({ ...p.valid, omp: { ...p.valid.omp, sessionDir: path.join(p.work, ".sessions") } }),
			"sessionDir",
		],
		["a relative work tree", p => ({ ...p.valid, workdir: "project" }), "workdir"],
		["a zero owner timeout", p => ({ ...p.valid, ownerTimeoutMs: 0 }), "ownerTimeoutMs"],
		["no tools", p => ({ ...p.valid, omp: { ...p.valid.omp, tools: [] } }), "tools"],
		["a malformed env name", p => ({ ...p.valid, omp: { ...p.valid.omp, env: ["cursor-key"] } }), "env"],
	];
	for (const [name, make, named] of faults) {
		it(`rejects ${name}, naming ${named}`, () => {
			const p = layout();
			const problems = problemsOf(make(p), p.policyFile);
			expect(problems.join("\n")).toContain(named);
		});
	}

	it("rejects a policy file kept inside the work tree", () => {
		const p = layout();
		expect(problemsOf(p.valid, path.join(p.work, "policy.json")).join("\n")).toContain("policy file");
	});

	it("names every fault at once", () => {
		const p = layout();
		const problems = problemsOf({ ...p.valid, owner: "", allowlist: [], ownerTimeoutMs: -1 }, p.policyFile);
		expect(problems.length).toBeGreaterThanOrEqual(3);
	});

	it("accepts the documented example policy", async () => {
		const example = await Bun.file(path.join(PACKAGE, "examples", "policy.example.json")).json();
		const policy = parsePolicy(example, "/etc/omp-remote-command/policy.json");
		expect(policy.omp.toolRules).toEqual({ bash: "prompt" });
		expect(policy.omp.env).toEqual(["CURSOR_API_KEY"]);
	});

	it("reports a missing policy file as a policy error", async () => {
		const p = layout();
		await expect(loadPolicy(path.join(p.outside, "missing.json"))).rejects.toBeInstanceOf(PolicyError);
	});
});

describe("generated omp config and launch (AC-7)", () => {
	it("renders always-ask, prompt or deny rules only, and collab off", () => {
		const p = layout();
		const policy = parsePolicy(
			{
				...p.valid,
				omp: {
					...p.valid.omp,
					toolRules: { bash: "prompt", task: "deny" },
					bashPatterns: [
						{ match: "rm -rf *", approval: "deny" },
						{ match: 'git push "origin"*', approval: "prompt" },
					],
				},
			},
			p.policyFile,
		);
		expect(Bun.YAML.parse(renderOmpConfig(policy))).toEqual({
			tools: { approvalMode: "always-ask", approval: { bash: "prompt", task: "deny" } },
			bash: {
				patterns: [
					{ match: "rm -rf *", approval: "deny" },
					{ match: 'git push "origin"*', approval: "prompt" },
				],
			},
			collab: { autoStart: "off" },
		});
	});

	it("starts omp in RPC mode with the locked flags, after the provider extensions", () => {
		const p = layout();
		const policy = parsePolicy(
			{
				...p.valid,
				omp: { ...p.valid.omp, extensions: ["/opt/ext/cursor-sdk"], thinking: "off", sessionDir: path.join(p.outside, "s") },
			},
			p.policyFile,
		);
		const { argv } = ompLaunch(policy, { extensionDir: "/opt/remote-command", configPath: "/tmp/rc/config.yml", baseEnv: {} });
		expect(argv).toEqual([
			"omp",
			"--mode",
			"rpc",
			"--cwd",
			p.work,
			"--no-extensions",
			"-e",
			"/opt/ext/cursor-sdk",
			"-e",
			"/opt/remote-command",
			"--config",
			"/tmp/rc/config.yml",
			"--approval-mode",
			"always-ask",
			"--tools",
			"read,bash",
			"--model",
			"cursor-sdk/claude-opus-5-5",
			"--thinking",
			"off",
			"--session-dir",
			path.join(p.outside, "s"),
			"--no-title",
			"--no-lsp",
			"--no-skills",
			"--no-rules",
		]);
	});

	it("passes only the basic variables and the policy's named keys to omp", () => {
		const p = layout();
		const policy = parsePolicy({ ...p.valid, omp: { ...p.valid.omp, env: ["CURSOR_API_KEY", "ABSENT_KEY"] } }, p.policyFile);
		const { env } = ompLaunch(policy, {
			extensionDir: "/opt/remote-command",
			configPath: "/tmp/rc/config.yml",
			baseEnv: {
				PATH: "/usr/bin",
				HOME: "/home/someone",
				USER: "someone",
				CURSOR_API_KEY: "model-key",
				CHAT_SIGNING_SECRET: "bridge-only",
			},
		});
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/someone",
			USER: "someone",
			LANG: "C.UTF-8",
			TERM: "dumb",
			CURSOR_API_KEY: "model-key",
		});
	});

	it("writes nothing when the policy is invalid", async () => {
		const p = layout();
		fs.writeFileSync(p.policyFile, JSON.stringify({ ...p.valid, allowlist: [] }));
		await expect(loadPolicy(p.policyFile)).rejects.toBeInstanceOf(PolicyError);
		expect(fs.readdirSync(p.outside)).toEqual(["policy.json"]);
	});
});
