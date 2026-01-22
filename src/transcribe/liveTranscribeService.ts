import { App, Editor, MarkdownView, Notice } from "obsidian";
import { startMicPcm16Capture, MicCaptureHandle } from "../audio/micPcm16Capture";
import {
	AssemblyAiRealtimeClient,
	AssemblyAiTranscriptEvent,
} from "./assemblyAiRealtimeClient";

export interface LiveTranscribeServiceOptions {
	app: App;
	getAssemblyAiApiKey: () => string;
	getAssemblyAiConfig: () => {
		sampleRate: number;
		chunkSizeSamples: number;
		encoding: "pcm_s16le" | "pcm_mulaw";
		formatTurns: boolean;
		endOfTurnConfidenceThreshold: number;
		minEndOfTurnSilenceMs: number;
		maxTurnSilenceMs: number;
	};
	getKeytermsPrompt?: () => Promise<string[]>;
	onStatusText?: (text: string) => void;
	onRunningChange?: (running: boolean) => void;
	onAudioFrame?: (data: Uint8Array) => void;
}

export class LiveTranscribeService {
	private readonly app: App;
	private readonly getAssemblyAiApiKey: () => string;
	private readonly getAssemblyAiConfig: LiveTranscribeServiceOptions["getAssemblyAiConfig"];
	private readonly getKeytermsPrompt?: LiveTranscribeServiceOptions["getKeytermsPrompt"];
	private readonly onStatusText?: (text: string) => void;
	private readonly onRunningChange?: (running: boolean) => void;
	private readonly onAudioFrame?: (data: Uint8Array) => void;

	private mic: MicCaptureHandle | null = null;
	private aai: AssemblyAiRealtimeClient | null = null;
	private unsubAai: (() => void) | null = null;

	private finalized = "";
	private current = "";
	private pendingUnformatted = "";
	private running = false;
	private insertFinalHandler: ((text: string) => void) | null = null;
	private insertPartialHandler: ((text: string) => void) | null = null;
	private insertPreviewHandler: ((text: string) => void) | null = null;

	constructor(opts: LiveTranscribeServiceOptions) {
		this.app = opts.app;
		this.getAssemblyAiApiKey = opts.getAssemblyAiApiKey;
		this.getAssemblyAiConfig = opts.getAssemblyAiConfig;
		this.getKeytermsPrompt = opts.getKeytermsPrompt;
		this.onStatusText = opts.onStatusText;
		this.onRunningChange = opts.onRunningChange;
		this.onAudioFrame = opts.onAudioFrame;
	}

	get isRunning() {
		return this.running;
	}

	private getActiveEditor(): Editor | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
	}

	async start(target?: {
		onFinalText: (text: string) => void;
		onPartialText?: (text: string) => void;
		onPreviewText?: (text: string) => void;
	}) {
		if (this.running) return;
		const apiKey = this.getAssemblyAiApiKey()?.trim();
		if (!apiKey) {
			new Notice("Missing AssemblyAI API key. Set it in plugin settings.");
			return;
		}
		const config = this.getAssemblyAiConfig();
		const sampleRate = Number.isFinite(config.sampleRate) && config.sampleRate > 0 ? config.sampleRate : 16000;
		const chunkSizeSamples =
			Number.isFinite(config.chunkSizeSamples) && config.chunkSizeSamples > 0
				? config.chunkSizeSamples
				: 800;
		let keytermsPrompt: string[] | undefined;
		try {
			keytermsPrompt = await this.getKeytermsPrompt?.();
		} catch {
			keytermsPrompt = undefined;
		}

		this.insertFinalHandler =
			target?.onFinalText ?? ((text) => this.insertFinalAtCursor(text));
		this.insertPartialHandler = target?.onPartialText ?? null;
		this.insertPreviewHandler = target?.onPreviewText ?? null;
		this.finalized = "";
		this.current = "";
		this.running = true;
		this.onRunningChange?.(true);
		this.onStatusText?.("Starting transcription…");

		this.aai = new AssemblyAiRealtimeClient({
			apiKey,
			sampleRate,
			encoding: config.encoding,
			formatTurns: config.formatTurns,
			endOfTurnConfidenceThreshold: config.endOfTurnConfidenceThreshold,
			minEndOfTurnSilenceMs: config.minEndOfTurnSilenceMs,
			maxTurnSilenceMs: config.maxTurnSilenceMs,
			keytermsPrompt,
		});
		this.unsubAai = this.aai.onEvent((ev) => this.handleAaiEvent(ev));

		try {
			await this.aai.connect();
		} catch (e) {
			this.onStatusText?.("Failed to connect.");
			this.running = false;
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`AssemblyAI connect failed: ${msg}`);
			this.cleanup();
			return;
		}

		try {
			this.mic = await startMicPcm16Capture({
				chunkSizeSamples,
				sampleRate,
				onPcm16Chunk: (chunk) => {
					this.aai?.sendPcm16Chunk(chunk);
				},
				onAudioFrame: (data) => {
					this.onAudioFrame?.(data);
				},
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Microphone failed: ${msg}`);
			this.stop();
			return;
		}

		this.onStatusText?.("Listening…");
		new Notice("Live transcription started.");
	}

	stop() {
		if (!this.running) return;
		this.flushPendingUnformatted();
		this.running = false;
		this.onRunningChange?.(false);
		this.onStatusText?.("Stopping…");
		this.cleanup();
		new Notice("Live transcription stopped.");
	}

	toggle() {
		if (this.running) this.stop();
		else void this.start();
	}

	private handleAaiEvent(ev: AssemblyAiTranscriptEvent) {
		if (ev.type === "transcript_update") {
			if (ev.is_final) {
				this.finalized += ev.text.trim() + " ";
				this.current = "";
				this.pendingUnformatted = "";
				this.insertFinalHandler?.(ev.text);
				this.insertPartialHandler?.("");
			} else {
				this.current = ev.text;
				if (ev.end_of_turn && ev.formatted === false) {
					this.pendingUnformatted = ev.text;
				}
				this.insertPartialHandler?.(ev.text);
			}
			const preview = (this.finalized + this.current).trim();
			this.onStatusText?.(preview || "Listening…");
			this.insertPreviewHandler?.(preview);
		} else if (ev.type === "session_terminated") {
			this.flushPendingUnformatted();
		} else if (ev.type === "error") {
			this.onStatusText?.("Transcription error.");
			new Notice(`Transcription error: ${ev.message}`);
			if (ev.message.toLowerCase().includes("not authorized")) {
				// Hard stop; auth problems won't recover without user action.
				this.stop();
			}
		}
	}

	private flushPendingUnformatted() {
		const fallback = (this.pendingUnformatted || this.current || "").trim();
		if (!fallback) return;
		this.insertFinalHandler?.(fallback);
		this.finalized += fallback + " ";
		this.current = "";
		this.pendingUnformatted = "";
		this.insertPartialHandler?.("");
	}

	private insertFinalAtCursor(text: string) {
		const editor = this.getActiveEditor();
		if (!editor) return;
		const out = text.trim();
		if (!out) return;

		const cursor = editor.getCursor();
		const prefix = cursor.ch === 0 ? "" : " ";
		const insertion = prefix + out + " ";
		editor.replaceRange(insertion, cursor);
		// Move cursor to end of inserted text so subsequent transcripts append.
		const nextCursor = advanceCursor(cursor, insertion);
		editor.setCursor(nextCursor);
	}

	private cleanup() {
		try {
			this.unsubAai?.();
		} catch {}
		this.unsubAai = null;
		this.insertFinalHandler = null;
		this.insertPartialHandler?.("");
		this.insertPartialHandler = null;
		this.insertPreviewHandler?.("");
		this.insertPreviewHandler = null;

		try {
			this.aai?.terminate();
		} catch {}
		this.aai = null;

		const mic = this.mic;
		this.mic = null;
		if (mic) {
			void mic.stop();
		}

		this.onStatusText?.("");
	}
}

function advanceCursor(
	cursor: { line: number; ch: number },
	text: string
): { line: number; ch: number } {
	const lines = text.split("\n");
	if (lines.length === 1) {
		const first = lines[0] ?? "";
		return { line: cursor.line, ch: cursor.ch + first.length };
	}
	const last = lines[lines.length - 1] ?? "";
	return { line: cursor.line + lines.length - 1, ch: last.length };
}

