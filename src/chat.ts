// The chat side of the bridge. A real adapter connects to a chat platform and must hand the bridge only
// identities the platform verified — the user ID from a signed webhook or from the platform's own
// connection — never a display name or a name claimed in the message text. This package includes no
// real platform adapter: SimulatedChat stands in for one, and verifyWebhookSignature is the check a
// webhook-based adapter runs before it calls the bridge.
import * as crypto from "node:crypto";

export interface ChannelMessage {
	/** Platform-verified sender. */
	userId: string;
	channelId: string;
	messageId: string;
	text: string;
}

export interface OwnerAnswer {
	/** Platform-verified sender of the answer. */
	userId: string;
	questionId: string;
	answer: string;
}

/** What the owner is asked in private before omp runs a tool. */
export interface OwnerQuestion {
	questionId: string;
	toolCallId: string;
	requester: string;
	channelId: string;
	messageId: string;
	/** The channel message that led to this tool call. */
	requestText: string;
	tool: string;
	/** The tool call's complete arguments, as omp reported them before asking. */
	args: unknown;
	/** omp's own question text. */
	ompTitle: string;
	/** ISO time; with no answer by then the bridge answers Deny. */
	deadline: string;
}

export interface ForwardResult {
	forwarded: boolean;
	reason?: string;
}

export interface ChatHandlers {
	onChannelMessage(message: ChannelMessage): Promise<ForwardResult>;
	onOwnerAnswer(answer: OwnerAnswer): Promise<void>;
}

export interface ChatAdapter {
	start(handlers: ChatHandlers): Promise<void>;
	postToChannel(channelId: string, text: string, replyTo?: string): Promise<void>;
	/** Deliver privately to the owner, e.g. a direct message with Approve and Deny buttons. */
	askOwner(ownerId: string, question: OwnerQuestion): Promise<void>;
	stop(): Promise<void>;
}

export interface WebhookSignatureCheck {
	secret: string;
	/** The platform's request timestamp header, in seconds. */
	timestamp: string;
	/** The raw request body, before any parsing. */
	body: string;
	/** The platform's signature header. */
	signature: string;
	nowSeconds?: number;
	toleranceSeconds?: number;
}

/**
 * Slack's request signing (v0): the signature is `v0=` plus the hex HMAC-SHA256 of
 * `v0:<timestamp>:<body>`. A timestamp outside the tolerance is rejected so a captured request
 * cannot be replayed later.
 */
export function verifyWebhookSignature(check: WebhookSignatureCheck): boolean {
	if (!/^\d+$/.test(check.timestamp)) return false;
	const now = check.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - Number(check.timestamp)) > (check.toleranceSeconds ?? 300)) return false;
	const digest = crypto.createHmac("sha256", check.secret).update(`v0:${check.timestamp}:${check.body}`).digest("hex");
	const expected = Buffer.from(`v0=${digest}`);
	const given = Buffer.from(check.signature);
	return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** An in-memory chat for tests and demos. Whatever user ID a caller passes counts as verified. */
export class SimulatedChat implements ChatAdapter {
	readonly channelPosts: Array<{ channelId: string; text: string; replyTo?: string }> = [];
	readonly ownerQuestions: Array<{ to: string; question: OwnerQuestion }> = [];
	/** Called for every owner question, e.g. to answer it from a script. */
	onQuestion?: (to: string, question: OwnerQuestion) => void;
	#handlers: ChatHandlers | undefined;
	#nextMessage = 1;

	async start(handlers: ChatHandlers): Promise<void> {
		this.#handlers = handlers;
	}

	async stop(): Promise<void> {
		this.#handlers = undefined;
	}

	async postToChannel(channelId: string, text: string, replyTo?: string): Promise<void> {
		this.channelPosts.push({ channelId, text, ...(replyTo ? { replyTo } : {}) });
	}

	async askOwner(to: string, question: OwnerQuestion): Promise<void> {
		this.ownerQuestions.push({ to, question });
		this.onQuestion?.(to, question);
	}

	/** A channel message from `userId`. */
	async say(userId: string, text: string, channelId = "C_TEAM"): Promise<ForwardResult & { messageId: string }> {
		const messageId = `M${this.#nextMessage++}`;
		if (!this.#handlers) return { forwarded: false, reason: "chat not started", messageId };
		return { ...(await this.#handlers.onChannelMessage({ userId, channelId, messageId, text })), messageId };
	}

	/** A private answer from `userId` to an owner question. */
	async answer(userId: string, questionId: string, answer: string): Promise<void> {
		await this.#handlers?.onOwnerAnswer({ userId, questionId, answer });
	}
}
