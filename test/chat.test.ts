import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import { verifyWebhookSignature } from "../src/chat";

const SECRET = "test-signing-secret";
const NOW = 1_760_000_000;
const BODY = '{"event":{"type":"message","user":"U_TEAMMATE","text":"run the tests"}}';

function sign(secret: string, timestamp: string, body: string): string {
	return `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

describe("webhook signature check (AC-8)", () => {
	const timestamp = String(NOW - 10);
	const valid = sign(SECRET, timestamp, BODY);

	it("accepts the platform's signature over timestamp and body", () => {
		expect(verifyWebhookSignature({ secret: SECRET, timestamp, body: BODY, signature: valid, nowSeconds: NOW })).toBe(true);
	});

	it("rejects a changed body", () => {
		const body = BODY.replace("U_TEAMMATE", "U_OWNER");
		expect(verifyWebhookSignature({ secret: SECRET, timestamp, body, signature: valid, nowSeconds: NOW })).toBe(false);
	});

	it("rejects a signature made with another secret", () => {
		const signature = sign("someone-else", timestamp, BODY);
		expect(verifyWebhookSignature({ secret: SECRET, timestamp, body: BODY, signature, nowSeconds: NOW })).toBe(false);
	});

	it("rejects a signature without the v0= prefix or of the wrong length", () => {
		const bare = valid.slice("v0=".length);
		expect(verifyWebhookSignature({ secret: SECRET, timestamp, body: BODY, signature: bare, nowSeconds: NOW })).toBe(false);
		expect(verifyWebhookSignature({ secret: SECRET, timestamp, body: BODY, signature: `${valid}00`, nowSeconds: NOW })).toBe(false);
	});

	it("rejects a timestamp more than 300 s from now, in either direction, so a captured request cannot be replayed", () => {
		for (const t of [NOW - 301, NOW + 301]) {
			const ts = String(t);
			expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, body: BODY, signature: sign(SECRET, ts, BODY), nowSeconds: NOW })).toBe(false);
		}
	});

	it("rejects a timestamp that is not a number", () => {
		const ts = "soon";
		expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, body: BODY, signature: sign(SECRET, ts, BODY), nowSeconds: NOW })).toBe(false);
	});
});
