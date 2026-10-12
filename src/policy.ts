// The bridge's policy file and the omp it starts. Everything the workflow fixes before startup comes
// from here: who may talk to omp, who answers its questions, and the flags and settings omp runs with.
// The policy is JSON kept outside the work tree; the bridge re-reads it for every message.
import * as path from "node:path";

export type ToolRule = "prompt" | "deny";

export interface BashPatternRule {
	match: string;
	approval: ToolRule;
}

export interface OmpLaunchSettings {
	/** How to run omp, e.g. ["omp"] or ["bun", "/path/to/cli.ts"]. */
	command: string[];
	model: string;
	thinking?: string;
	/** Model-provider extensions, loaded with -e before this package. */
	extensions: string[];
	tools: string[];
	/** `tools.approval` in the generated config. */
	toolRules: Record<string, ToolRule>;
	/** `bash.patterns` in the generated config. */
	bashPatterns: BashPatternRule[];
	/** Names of environment variables omp gets besides the basic ones, e.g. the model key. */
	env: string[];
	sessionDir?: string;
}

export interface Policy {
	/** The one platform user ID that answers omp's questions. */
	owner: string;
	/** Platform user IDs that may send omp a request. */
	allowlist: string[];
	ownerTimeoutMs: number;
	workdir: string;
	auditLog: string;
	omp: OmpLaunchSettings;
}

export const DEFAULT_OWNER_TIMEOUT_MS = 120_000;
const MAX_OWNER_TIMEOUT_MS = 3_600_000;
/** Read-tier tools; every other tool in the policy gets a `prompt` rule unless the policy names one. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "find", "ls", "ast_grep"]);
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const BASIC_ENV = ["PATH", "HOME", "USER"];
const SKIPS_OWNER = 'is "allow", which would let a call run without the owner';

export class PolicyError extends Error {
	constructor(readonly problems: string[]) {
		super(`invalid bridge policy: ${problems.join("; ")}`);
		this.name = "PolicyError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? (value as string[]) : undefined;
}

function isInside(target: string, dir: string): boolean {
	const relative = path.relative(dir, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rule(value: unknown): ToolRule | "allow" | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "prompt" || normalized === "deny" || normalized === "allow" ? normalized : undefined;
}

/** Validates a parsed policy; `file` is where it was read from. Throws a PolicyError naming every fault. */
export function parsePolicy(raw: unknown, file: string): Policy {
	const problems: string[] = [];
	const fault = (problem: string) => {
		problems.push(problem);
	};
	const top = isRecord(raw) ? raw : (fault("the policy must be a JSON object"), {});
	const omp = isRecord(top.omp) ? top.omp : (fault("omp must be an object"), {});

	const owner = typeof top.owner === "string" ? top.owner.trim() : "";
	if (!owner || owner === "*") fault("owner must name one platform user ID");

	const allowlist = stringList(top.allowlist)?.map(id => id.trim()) ?? [];
	if (allowlist.length === 0) fault("allowlist must list at least one platform user ID");
	else if (allowlist.some(id => !id || id === "*")) fault("allowlist entries must be platform user IDs, not empty or *");

	const ownerTimeoutMs = top.ownerTimeoutMs ?? DEFAULT_OWNER_TIMEOUT_MS;
	if (typeof ownerTimeoutMs !== "number" || !(ownerTimeoutMs >= 1 && ownerTimeoutMs <= MAX_OWNER_TIMEOUT_MS)) {
		fault(`ownerTimeoutMs must be between 1 and ${MAX_OWNER_TIMEOUT_MS}`);
	}

	const absolute = (value: unknown, name: string): string => {
		if (typeof value === "string" && path.isAbsolute(value)) return path.resolve(value);
		fault(`${name} must be an absolute path`);
		return "";
	};
	const workdir = absolute(top.workdir, "workdir");
	const auditLog = absolute(top.auditLog, "auditLog");
	const sessionDir = omp.sessionDir === undefined ? undefined : absolute(omp.sessionDir, "omp.sessionDir");
	if (workdir) {
		if (auditLog && isInside(auditLog, workdir)) fault("auditLog must be outside workdir");
		if (sessionDir && isInside(sessionDir, workdir)) fault("omp.sessionDir must be outside workdir");
		if (isInside(path.resolve(file), workdir)) fault("the policy file must be outside workdir");
	}

	const command = stringList(omp.command) ?? [];
	if (command.length === 0 || command.some(part => !part)) fault("omp.command must be a non-empty list of strings");
	const model = typeof omp.model === "string" ? omp.model.trim() : "";
	if (!model) fault("omp.model must name a model");
	let thinking: string | undefined;
	if (omp.thinking !== undefined) {
		if (typeof omp.thinking === "string" && omp.thinking.trim()) thinking = omp.thinking.trim();
		else fault("omp.thinking must be a thinking level");
	}
	const extensions = omp.extensions === undefined ? [] : (stringList(omp.extensions) ?? []);
	if (omp.extensions !== undefined && (!stringList(omp.extensions) || extensions.some(e => !path.isAbsolute(e)))) {
		fault("omp.extensions must be a list of absolute paths");
	}

	const tools = stringList(omp.tools) ?? [];
	if (tools.length === 0 || tools.some(tool => !TOOL_NAME.test(tool))) fault("omp.tools must list at least one tool name");

	const toolRules: Record<string, ToolRule> = {};
	for (const tool of tools) if (!READ_ONLY_TOOLS.has(tool)) toolRules[tool] = "prompt";
	if (omp.toolRules !== undefined) {
		if (!isRecord(omp.toolRules)) fault("omp.toolRules must map tool names to prompt or deny");
		else {
			for (const [tool, value] of Object.entries(omp.toolRules)) {
				const normalized = rule(value);
				if (normalized === "allow") fault(`omp.toolRules.${tool} ${SKIPS_OWNER}`);
				else if (!normalized || !TOOL_NAME.test(tool)) fault(`omp.toolRules.${tool} must be prompt or deny`);
				else toolRules[tool] = normalized;
			}
		}
	}

	const bashPatterns: BashPatternRule[] = [];
	if (omp.bashPatterns !== undefined) {
		if (!Array.isArray(omp.bashPatterns)) fault("omp.bashPatterns must be a list of { match, approval }");
		else {
			omp.bashPatterns.forEach((item: unknown, index: number) => {
				const match = isRecord(item) && typeof item.match === "string" ? item.match.trim() : "";
				const approval = isRecord(item) ? rule(item.approval) : undefined;
				if (approval === "allow") fault(`omp.bashPatterns[${index}] ${SKIPS_OWNER}`);
				else if (!match || !approval) fault(`omp.bashPatterns[${index}] must have a match and an approval of prompt or deny`);
				else bashPatterns.push({ match, approval });
			});
		}
	}

	const env = omp.env === undefined ? [] : (stringList(omp.env) ?? []);
	if (omp.env !== undefined && (!stringList(omp.env) || env.some(name => !ENV_NAME.test(name)))) {
		fault("omp.env must list environment variable names such as CURSOR_API_KEY");
	}

	if (problems.length > 0) throw new PolicyError(problems);
	return {
		owner,
		allowlist,
		ownerTimeoutMs: ownerTimeoutMs as number,
		workdir,
		auditLog,
		omp: {
			command,
			model,
			...(thinking ? { thinking } : {}),
			extensions,
			tools,
			toolRules,
			bashPatterns,
			env,
			...(sessionDir ? { sessionDir } : {}),
		},
	};
}

export async function loadPolicy(file: string): Promise<Policy> {
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(file).text());
	} catch (err) {
		throw new PolicyError([`cannot read the policy file ${file} (${err instanceof Error ? err.message : String(err)})`]);
	}
	return parsePolicy(raw, file);
}

/** The settings overlay omp is started with (`--config`); YAML with every scalar JSON-quoted. */
export function renderOmpConfig(policy: Policy): string {
	const quote = (value: string) => JSON.stringify(value);
	const lines = ["# Written by omp-remote-command when the bridge starts. Edit the bridge policy instead.", "tools:"];
	lines.push(`  approvalMode: ${quote("always-ask")}`);
	const rules = Object.entries(policy.omp.toolRules);
	lines.push(rules.length > 0 ? "  approval:" : "  approval: {}");
	for (const [tool, value] of rules) lines.push(`    ${quote(tool)}: ${quote(value)}`);
	lines.push("bash:");
	lines.push(policy.omp.bashPatterns.length > 0 ? "  patterns:" : "  patterns: []");
	for (const pattern of policy.omp.bashPatterns) {
		lines.push(`    - match: ${quote(pattern.match)}`, `      approval: ${quote(pattern.approval)}`);
	}
	lines.push("collab:", `  autoStart: ${quote("off")}`);
	return `${lines.join("\n")}\n`;
}

export interface OmpLaunchOptions {
	/** This package's folder, loaded with -e. */
	extensionDir: string;
	configPath: string;
	/** Where omp's environment is picked from; defaults to process.env. */
	baseEnv?: Record<string, string | undefined>;
}

/** The command line and the whole environment for the omp child. */
export function ompLaunch(policy: Policy, options: OmpLaunchOptions): { argv: string[]; env: Record<string, string> } {
	const omp = policy.omp;
	const argv = [
		...omp.command,
		"--mode",
		"rpc",
		"--cwd",
		policy.workdir,
		"--no-extensions",
		...omp.extensions.flatMap(extension => ["-e", extension]),
		"-e",
		options.extensionDir,
		"--config",
		options.configPath,
		"--approval-mode",
		"always-ask",
		"--tools",
		omp.tools.join(","),
		"--model",
		omp.model,
		...(omp.thinking ? ["--thinking", omp.thinking] : []),
		...(omp.sessionDir ? ["--session-dir", omp.sessionDir] : []),
		"--no-title",
		"--no-lsp",
		"--no-skills",
		"--no-rules",
	];
	const base = options.baseEnv ?? process.env;
	const env: Record<string, string> = {};
	for (const name of BASIC_ENV) {
		const value = base[name];
		if (value !== undefined) env[name] = value;
	}
	env.LANG = base.LANG ?? "C.UTF-8";
	env.TERM = "dumb";
	for (const name of omp.env) {
		const value = base[name];
		if (value !== undefined) env[name] = value;
	}
	return { argv, env };
}
