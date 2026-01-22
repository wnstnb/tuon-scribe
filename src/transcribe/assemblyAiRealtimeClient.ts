import { requestUrl } from "obsidian";
import { normalizeApiKey } from "../diagnostics/apiKeyDiagnostics";

export type AssemblyAiTranscriptEvent =
	| { type: "session_begin"; session_id?: string }
	| {
			type: "transcript_update";
			text: string;
			is_final: boolean;
			end_of_turn?: boolean;
			formatted?: boolean;
	  }
	| { type: "session_terminated" }
	| { type: "error"; message: string };

export interface AssemblyAiRealtimeClientOptions {
	apiKey: string;
	sampleRate: number; // 16000
	encoding?: "pcm_s16le" | "pcm_mulaw";
	formatTurns?: boolean;
	endOfTurnConfidenceThreshold?: number;
	minEndOfTurnSilenceMs?: number;
	maxTurnSilenceMs?: number;
	keytermsPrompt?: string[];
}

export class AssemblyAiRealtimeClient {
	private ws: WebSocket | null = null;
	private readonly apiKey: string;
	private readonly sampleRate: number;
	private readonly encoding: "pcm_s16le" | "pcm_mulaw";
	private readonly formatTurns: boolean;
	private readonly endOfTurnConfidenceThreshold?: number;
	private readonly minEndOfTurnSilenceMs?: number;
	private readonly maxTurnSilenceMs?: number;
	private readonly keytermsPrompt?: string[];

	private onEventHandlers = new Set<(ev: AssemblyAiTranscriptEvent) => void>();

	constructor(opts: AssemblyAiRealtimeClientOptions) {
		this.apiKey = opts.apiKey;
		this.sampleRate = opts.sampleRate;
		this.encoding = opts.encoding ?? "pcm_s16le";
		this.formatTurns = opts.formatTurns ?? true;
		this.endOfTurnConfidenceThreshold = opts.endOfTurnConfidenceThreshold;
		this.minEndOfTurnSilenceMs = opts.minEndOfTurnSilenceMs;
		this.maxTurnSilenceMs = opts.maxTurnSilenceMs;
		this.keytermsPrompt = opts.keytermsPrompt;
	}

	onEvent(handler: (ev: AssemblyAiTranscriptEvent) => void): () => void {
		this.onEventHandlers.add(handler);
		return () => this.onEventHandlers.delete(handler);
	}

	private emit(ev: AssemblyAiTranscriptEvent) {
		for (const h of this.onEventHandlers) {
			try {
				h(ev);
			} catch {
				// ignore handler errors
			}
		}
	}

	get isConnected() {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	async connect(): Promise<void> {
		if (!this.apiKey?.trim()) throw new Error("Missing AssemblyAI API key.");
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
			return;
		}

		// Universal Streaming requires a temporary token in the query string (recommended).
		// Docs: https://www.assemblyai.com/docs/universal-streaming
		const token = await createTemporaryStreamingToken(this.apiKey.trim());

		// Universal Streaming WS endpoint (US region). EU endpoint uses streaming.eu.assemblyai.com.
		const url = new URL("wss://streaming.assemblyai.com/v3/ws");
		url.searchParams.set("token", token);
		url.searchParams.set("sample_rate", String(this.sampleRate));
		url.searchParams.set("encoding", this.encoding);
		url.searchParams.set("format_turns", this.formatTurns ? "true" : "false");
		if (Number.isFinite(this.endOfTurnConfidenceThreshold)) {
			url.searchParams.set(
				"end_of_turn_confidence_threshold",
				String(this.endOfTurnConfidenceThreshold)
			);
		}
		if (Number.isFinite(this.minEndOfTurnSilenceMs)) {
			url.searchParams.set(
				"min_end_of_turn_silence_when_confident",
				String(this.minEndOfTurnSilenceMs)
			);
		}
		if (Number.isFinite(this.maxTurnSilenceMs)) {
			url.searchParams.set("max_turn_silence", String(this.maxTurnSilenceMs));
		}
		if (this.keytermsPrompt && this.keytermsPrompt.length > 0) {
			url.searchParams.set("keyterms_prompt", JSON.stringify(this.keytermsPrompt));
		}

		this.ws = new WebSocket(url.toString());
		this.ws.binaryType = "arraybuffer";

		this.ws.onerror = () => {
			this.emit({ type: "error", message: "WebSocket error connecting to AssemblyAI streaming." });
		};

		this.ws.onclose = (event: CloseEvent) => {
			const reason = (event?.reason || "").trim();
			if (reason) this.emit({ type: "error", message: reason });
			this.emit({ type: "session_terminated" });
		};

		this.ws.onmessage = (event: MessageEvent) => {
			const dataStr = typeof event.data === "string" ? event.data : "";
			if (!dataStr) return;
			this.handleMessageString(dataStr);
		};

		await new Promise<void>((resolve, reject) => {
			const ws = this.ws!;
			const onOpen = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to connect to AssemblyAI WebSocket."));
			};
			const cleanup = () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
			};
			ws.addEventListener("open", onOpen, { once: true });
			ws.addEventListener("error", onError, { once: true });
		});
	}

	sendPcm16Chunk(pcm16: ArrayBuffer) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		try {
			// Universal Streaming expects raw binary audio frames (recommended 50ms per message).
			this.ws.send(pcm16);
		} catch {
			// ignore send errors
		}
	}

	terminate() {
		if (!this.ws) return;
		try {
			if (this.ws.readyState === WebSocket.OPEN) {
				// Universal Streaming termination message.
				this.ws.send(JSON.stringify({ type: "Terminate" }));
			}
		} catch {}
		try {
			this.ws.close();
		} catch {}
		this.ws = null;
	}

	private handleMessageString(dataStr: string) {
		try {
			if (!dataStr) return;
			const msg = JSON.parse(dataStr) as any;

			const type: string | undefined = msg?.type;
			if (type === "Begin") {
				this.emit({ type: "session_begin", session_id: msg?.id });
				return;
			}

			if (type === "Turn") {
				const transcript: string | undefined = msg?.transcript;
				const endOfTurn: boolean = !!msg?.end_of_turn;
				const formatted: boolean = !!msg?.turn_is_formatted;

				if (typeof transcript === "string" && transcript.length > 0) {
					// Prefer formatted final turns when format_turns=true.
					const isFinal = endOfTurn && (formatted || !this.formatTurns);
					this.emit({
						type: "transcript_update",
						text: transcript,
						is_final: isFinal,
						end_of_turn: endOfTurn,
						formatted,
					});
				}
				return;
			}

			if (type === "Termination") {
				this.emit({ type: "session_terminated" });
				return;
			}

			const err = msg?.error || msg?.message;
			if (typeof err === "string" && err.trim()) {
				this.emit({ type: "error", message: err.trim() });
			}
		} catch {
			// ignore parse errors
		}
	}
}

async function createTemporaryStreamingToken(apiKey: string): Promise<string> {
	// Universal Streaming docs recommend authenticating WS sessions using a generated temporary token:
	// https://www.assemblyai.com/docs/universal-streaming
	//
	// Token is minted by calling the streaming token endpoint with your API key in Authorization:
	// GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=60
	// Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming/authenticate-with-a-temporary-token
	let result: any;
	try {
		const key = normalizeApiKey(apiKey);
		// Use Obsidian's requestUrl to avoid CORS/"failed to fetch" issues in the renderer.
		// Some environments may require "Bearer <key>" — try raw first, then Bearer.
		let r;
		try {
			r = await requestUrl({
				url: "https://streaming.assemblyai.com/v3/token?expires_in_seconds=600",
				method: "GET",
				headers: { Authorization: key },
			});
		} catch {
			r = await requestUrl({
				url: "https://streaming.assemblyai.com/v3/token?expires_in_seconds=600",
				method: "GET",
				headers: { Authorization: `Bearer ${key}` },
			});
		}
		result = r.json;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to mint AssemblyAI streaming token: ${msg}`);
	}

	const token = result?.token;
	if (!token || typeof token !== "string") {
		throw new Error("AssemblyAI token endpoint returned no token.");
	}
	return token;
}

