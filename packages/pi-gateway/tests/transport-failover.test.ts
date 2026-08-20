import { describe, expect, it, vi } from "vitest";

import { createGatewayTransport, type UnknownModel } from "../src/transport-core.js";

interface TestMessage {
	role: "assistant";
	content: unknown[];
	provider: string;
	model: string;
	stopReason: "stop" | "error";
	errorStatus?: number;
	errorMessage?: string;
}

function source(events: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
}

function message(provider: string, stopReason: "stop" | "error"): TestMessage {
	return {
		role: "assistant",
		content: [],
		provider,
		model: "real-model",
		stopReason,
		...(stopReason === "error"
			? { errorStatus: 503, errorMessage: "service unavailable" }
			: {}),
	};
}

function target(backendName: string) {
	return {
		backendName,
		realApi: "test-api",
		realModelId: "real-model",
		realBaseUrl: "https://example.invalid",
		realModel: { id: "real-model", api: "test-api", provider: backendName },
		realAuth: { auth: { apiKey: `${backendName}-key` } },
	};
}

async function collect(stream: unknown): Promise<any[]> {
	const events: any[] = [];
	for await (const event of stream as AsyncIterable<any>) events.push(event);
	return events;
}

describe("gateway transport failover", () => {
	it("suppresses a pre-output transient failure and retries through the new route", async () => {
		const deliver = vi.fn((_kind: unknown, model: UnknownModel) => {
			const provider = String(model.provider);
			const output = message(provider, provider === "backend-a" ? "error" : "stop");
			return provider === "backend-a"
				? source([{ type: "start", partial: output }, { type: "error", reason: "error", error: output }])
				: source([
						{ type: "start", partial: output },
						{ type: "text_delta", contentIndex: 0, delta: "ok", partial: output },
						{ type: "done", reason: "stop", message: output },
					]);
		});
		const transport = createGatewayTransport({ registerApi: vi.fn(), deliver });
		transport.setRoutes({ "heavy-1": target("backend-a") });
		const onFailure = vi.fn(async () => {
			transport.setRoutes({ "heavy-1": target("backend-b") });
			return true;
		});
		transport.setFailureHandler(onFailure);
		const reportUsage = vi.fn();
		transport.setUsageReporter(reportUsage);

		const stream = transport.streamSimple({ id: "heavy-1" }, {}, {});
		const events = await collect(stream);

		expect(deliver).toHaveBeenCalledTimes(2);
		expect(deliver.mock.calls[0][3]).toMatchObject({ apiKey: "backend-a-key" });
		expect(deliver.mock.calls[1][3]).toMatchObject({ apiKey: "backend-b-key" });
		expect(onFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				aliasId: "heavy-1",
				backendName: "backend-a",
				errorStatus: 503,
			}),
		);
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
		expect(events.at(-1).message.provider).toBe("backend-b");
		expect(reportUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "pi-gateway",
				operation: "retry-start",
				model: "gateway/heavy-1",
				status: "start",
				retryLayer: "gateway",
				attempt: 1,
				route: "backend-a->backend-b",
			}),
		);
		expect(reportUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "pi-gateway",
				operation: "retry-complete",
				status: "complete",
				retryLayer: "gateway",
				attempt: 1,
				route: "backend-a->backend-b",
			}),
		);
	});

	it("does not replay after semantic output has already streamed", async () => {
		const output = message("backend-a", "error");
		const deliver = vi.fn(() =>
			source([
				{ type: "start", partial: output },
				{ type: "text_delta", contentIndex: 0, delta: "partial", partial: output },
				{ type: "error", reason: "error", error: output },
			]),
		);
		const transport = createGatewayTransport({ registerApi: vi.fn(), deliver });
		transport.setRoutes({ "heavy-1": target("backend-a") });
		const onFailure = vi.fn(async () => true);
		transport.setFailureHandler(onFailure);

		const events = await collect(transport.streamSimple({ id: "heavy-1" }, {}, {}));

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(onFailure).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
	});
});
