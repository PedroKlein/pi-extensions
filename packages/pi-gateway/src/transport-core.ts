/**
 * Harness-agnostic gateway request transport.
 *
 * Why this exists: both pi and oh-my-pi send `model.id` verbatim as the wire
 * model name — every builtin transport does `model: model.id`. A neutral alias
 * like `heavy-1` is not a real model name, so a backend rejects it:
 *   "Model name 'heavy-1' is not supported."
 *
 * Fix: the gateway registers its OWN api (`GATEWAY_API`) in the harness's api
 * registry. Gateway models carry `api: GATEWAY_API`, so requests route here. At
 * request time the harness has already resolved the gateway provider's
 * credential into `options.apiKey`; this transport maps the alias id to the
 * real backend model captured at compose time, then DELEGATES to that backend's
 * real transport (via the injected {@link TransportHost.deliver}) with the real
 * Model — real wire name, real baseUrl, native streaming preserved.
 *
 * The harness-specific bits (how to register a custom api, and how to dispatch
 * a real model to its transport) are injected via {@link TransportHost}, so
 * this module has no pi / oh-my-pi imports and unit-tests with fakes.
 */

import type { GatewayRouteTarget } from "./compose.js";
import { GATEWAY_API } from "./config.js";

// Minimal structural types — kept local so this module doesn't couple to a
// specific pi-ai Model/Context/options version.
export type UnknownModel = { id: string; [key: string]: unknown };
export type StreamKind = "stream" | "streamSimple";

/** The api-transport spec handed to the harness for registration. */
export interface GatewayApiSpec {
	api: string;
	stream: (model: UnknownModel, context: unknown, options: unknown) => unknown;
	streamSimple: (model: UnknownModel, context: unknown, options: unknown) => unknown;
}

/** Harness-specific hooks the transport needs. */
export interface TransportHost {
	/** Register the gateway api transport in the harness's api registry. */
	registerApi(spec: GatewayApiSpec, sourceId: string): void;
	/**
	 * Dispatch an already-resolved real model to its backend transport. On pi
	 * this looks up `getApiProvider(realModel.api)`; on oh-my-pi it calls the
	 * top-level `stream`/`streamSimple` (which route custom + builtin apis).
	 */
	deliver(kind: StreamKind, realModel: UnknownModel, context: unknown, options: unknown): unknown;
}

export interface GatewayFailure {
	aliasId: string;
	backendName: string;
	errorStatus?: number;
	errorMessage?: string;
}

export type GatewayFailureHandler = (failure: GatewayFailure) => Promise<boolean>;

export interface GatewayUsageEvent {
	source: "pi-gateway";
	operation: "retry-start" | "retry-complete" | "retry-error";
	model: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number;
	durationMs: number;
	trigger: "automatic";
	status: "start" | "complete" | "error";
	retryLayer: "gateway";
	attempt: number;
	route: string;
}

export interface GatewayTransport {
	/** Register the `gateway` api once (idempotent). Used by the pi host, whose
	 * api registry is reachable via a direct `registerApiProvider`. On oh-my-pi
	 * this is a no-op: the custom api is registered through `registerProvider`
	 * (see omp-platform) so it lands in the same bundled pi-ai instance the host
	 * dispatches through, and {@link GatewayTransport.streamSimple} is handed to
	 * that provider config. */
	register(): void;
	/** The routed stream delegate (alias→real swap + deliver). */
	stream(model: UnknownModel, context: unknown, options: unknown): unknown;
	/** The routed streamSimple delegate (alias→real swap + deliver). */
	streamSimple(model: UnknownModel, context: unknown, options: unknown): unknown;
	/** Replace the live alias→target routing map (called on every re-register). */
	setRoutes(targets: Record<string, GatewayRouteTarget>): void;
	/** Install the controller callback that marks a failed backend unhealthy and rebuilds routes. */
	setFailureHandler(handler: GatewayFailureHandler | undefined): void;
	/** Report transport failover attempts to an optional observability sink. */
	setUsageReporter?(reporter: ((event: GatewayUsageEvent) => void) | undefined): void;
	/** Number of live routes (test seam). */
	routeCount(): number;
	/** Reset routes + registration flag (test seam). */
	reset(): void;
}

const SOURCE_ID = "pi-gateway";

/**
 * Create a gateway transport bound to a harness host. The returned object owns
 * a live alias→target routing map, replaced wholesale on every re-register so a
 * failover transparently reroutes in-flight aliases without re-registering the
 * api.
 */
export function createGatewayTransport(host: TransportHost): GatewayTransport {
	let routes = new Map<string, GatewayRouteTarget>();
	let registered = false;
	let failureHandler: GatewayFailureHandler | undefined;
	let usageReporter: ((event: GatewayUsageEvent) => void) | undefined;

	function backendName(target: GatewayRouteTarget): string {
		const model = target.realModel as Record<string, unknown> | undefined;
		return target.backendName ?? String(model?.provider ?? target.realApi);
	}

	function backendOptions(target: GatewayRouteTarget, options: unknown): unknown {
		if (!target.realAuth) return options;
		const incoming = (options ?? {}) as Record<string, unknown>;
		const headers = {
			...(target.realAuth.auth.headers ?? {}),
			...((incoming.headers as Record<string, string> | undefined) ?? {}),
		};
		const env = {
			...(target.realAuth.env ?? {}),
			...((incoming.env as Record<string, string> | undefined) ?? {}),
		};
		return {
			...incoming,
			apiKey: target.realAuth.auth.apiKey,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			env: Object.keys(env).length > 0 ? env : undefined,
		};
	}

	function deliverTarget(
		kind: StreamKind,
		target: GatewayRouteTarget,
		context: unknown,
		options: unknown,
	): unknown {
		const realModel: UnknownModel = {
			...(target.realModel as Record<string, unknown>),
			id: target.realModelId,
			api: target.realApi,
			baseUrl: target.realAuth?.auth.baseUrl ?? target.realBaseUrl,
		};
		const resolvedOptions = backendOptions(target, options);
		if (target.realProvider) {
			return target.realProvider[kind](realModel, context, resolvedOptions);
		}
		return host.deliver(kind, realModel, context, resolvedOptions);
	}

	function delegate(kind: StreamKind) {
		return (model: UnknownModel, context: unknown, options: unknown): unknown => {
			const target = routes.get(model.id);
			if (!target) {
				throw new Error(
					`gateway: no route for '${model.id}' — the alias set is stale; run /gateway reload`,
				);
			}
			const first = deliverTarget(kind, target, context, options);
			if (!failureHandler || !isAsyncIterable(first)) return first;
			return retryingStream({
				aliasId: model.id,
				first,
				firstTarget: target,
				getTarget: () => routes.get(model.id),
				deliver: (next) => deliverTarget(kind, next, context, options),
				onFailure: failureHandler,
				backendName,
				reportUsage: usageReporter,
			});
		};
	}

	return {
		register() {
			if (registered) return;
			host.registerApi(
				{ api: GATEWAY_API, stream: delegate("stream"), streamSimple: delegate("streamSimple") },
				SOURCE_ID,
			);
			registered = true;
		},
		stream: delegate("stream"),
		streamSimple: delegate("streamSimple"),
		setRoutes(targets) {
			routes = new Map(Object.entries(targets));
		},
		setFailureHandler(handler) {
			failureHandler = handler;
		},
		setUsageReporter(reporter) {
			usageReporter = reporter;
		},
		routeCount() {
			return routes.size;
		},
		reset() {
			routes = new Map();
			failureHandler = undefined;
			usageReporter = undefined;
			registered = false;
		},
	};
}

interface GatewayEvent {
	type: string;
	error?: Record<string, unknown>;
	message?: Record<string, unknown>;
	[key: string]: unknown;
}

interface RetryingStreamInput {
	aliasId: string;
	first: AsyncIterable<GatewayEvent>;
	firstTarget: GatewayRouteTarget;
	getTarget: () => GatewayRouteTarget | undefined;
	deliver: (target: GatewayRouteTarget) => unknown;
	onFailure: GatewayFailureHandler;
	backendName: (target: GatewayRouteTarget) => string;
	reportUsage?: (event: GatewayUsageEvent) => void;
}

function retryingStream(input: RetryingStreamInput): AsyncIterable<GatewayEvent> & { result(): Promise<unknown> } {
	const output = new GatewayEventStream();
	const attempted = new Set<string>();

	async function pump(source: AsyncIterable<GatewayEvent>, target: GatewayRouteTarget): Promise<"complete" | "error"> {
		const currentBackend = input.backendName(target);
		attempted.add(currentBackend);
		const buffered: GatewayEvent[] = [];
		let committed = false;
		try {
			for await (const event of source) {
				if (event.type === "error") {
					if (committed) {
						output.push(event);
						return "error";
					}
					const error = event.error ?? {};
					const retry = await input.onFailure({
						aliasId: input.aliasId,
						backendName: currentBackend,
						errorStatus: numericStatus(error.errorStatus),
						errorMessage: typeof error.errorMessage === "string" ? error.errorMessage : undefined,
					});
					const next = retry ? input.getTarget() : undefined;
					const nextBackend = next ? input.backendName(next) : undefined;
					if (next && nextBackend && !attempted.has(nextBackend)) {
						const attempt = attempted.size;
						const route = `${currentBackend}->${nextBackend}`;
						const startedAt = Date.now();
						input.reportUsage?.(gatewayRetryUsage("start", input.aliasId, attempt, route, 0));
						try {
							const nextSource = input.deliver(next);
							if (isAsyncIterable(nextSource)) {
								const outcome = await pump(nextSource, next);
								input.reportUsage?.(
									gatewayRetryUsage(outcome, input.aliasId, attempt, route, Date.now() - startedAt),
								);
								return outcome;
							}
						} catch (retryError) {
							input.reportUsage?.(gatewayRetryUsage("error", input.aliasId, attempt, route, Date.now() - startedAt));
							throw retryError;
						}
						input.reportUsage?.(gatewayRetryUsage("error", input.aliasId, attempt, route, Date.now() - startedAt));
					}
					for (const pending of buffered) output.push(pending);
					output.push(event);
					return "error";
				}

				if (event.type === "done") {
					for (const pending of buffered) output.push(pending);
					output.push(event);
					return "complete";
				}

				if (!committed && isSemanticEvent(event)) {
					committed = true;
					for (const pending of buffered) output.push(pending);
					buffered.length = 0;
				}
				if (committed) output.push(event);
				else buffered.push(event);
			}
			output.end();
			return "error";
		} catch (err) {
			output.fail(err);
			return "error";
		}
	}

	void pump(input.first, input.firstTarget);
	return output;
}

function gatewayRetryUsage(
	status: "start" | "complete" | "error",
	aliasId: string,
	attempt: number,
	route: string,
	durationMs: number,
): GatewayUsageEvent {
	return {
		source: "pi-gateway",
		operation: `retry-${status}`,
		model: `gateway/${aliasId}`,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		reasoning: 0,
		durationMs,
		trigger: "automatic",
		status,
		retryLayer: "gateway",
		attempt,
		route,
	};
}

function isAsyncIterable(value: unknown): value is AsyncIterable<GatewayEvent> {
	return Boolean(value && typeof (value as AsyncIterable<GatewayEvent>)[Symbol.asyncIterator] === "function");
}

function isSemanticEvent(event: GatewayEvent): boolean {
	return event.type !== "start" && event.type !== "usage";
}

function numericStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

class GatewayEventStream implements AsyncIterable<GatewayEvent> {
	private readonly queue: GatewayEvent[] = [];
	private readonly waiting: Array<{
		resolve: (value: IteratorResult<GatewayEvent>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private done = false;
	private failed: unknown;
	private settled = false;
	private readonly resultPromise: Promise<unknown>;
	private resolveResult!: (value: unknown) => void;
	private rejectResult!: (error: unknown) => void;

	constructor() {
		this.resultPromise = new Promise((resolve, reject) => {
			this.resolveResult = resolve;
			this.rejectResult = reject;
		});
		this.resultPromise.catch(() => {});
	}

	push(event: GatewayEvent): void {
		if (this.done) return;
		if (event.type === "done" || event.type === "error") {
			this.done = true;
			this.settled = true;
			this.resolveResult(event.type === "done" ? event.message : event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter.resolve({ value: event, done: false });
		else this.queue.push(event);
		if (this.done) this.finishWaiting();
	}

	end(): void {
		if (this.done) return;
		this.done = true;
		if (!this.settled) this.rejectResult(new Error("gateway: backend stream ended without a result"));
		this.finishWaiting();
	}

	fail(error: unknown): void {
		if (this.done) return;
		this.done = true;
		this.failed = error;
		this.rejectResult(error);
		while (this.waiting.length > 0) this.waiting.shift()!.reject(error);
	}

	result(): Promise<unknown> {
		return this.resultPromise;
	}

	get hasPendingLocalWork(): boolean {
		return false;
	}

	async trackLocalWork<T>(work: Promise<T>): Promise<T> {
		return work;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<GatewayEvent> {
		while (true) {
			if (this.queue.length > 0) yield this.queue.shift()!;
			else if (this.failed !== undefined) throw this.failed;
			else if (this.done) return;
			else {
				const next = await new Promise<IteratorResult<GatewayEvent>>((resolve, reject) => {
					this.waiting.push({ resolve, reject });
				});
				if (next.done) return;
				yield next.value;
			}
		}
	}

	private finishWaiting(): void {
		while (this.waiting.length > 0) {
			this.waiting.shift()!.resolve({ value: undefined as never, done: true });
		}
	}
}
