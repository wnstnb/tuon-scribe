import { requestUrl } from "obsidian";
import { normalizeApiKey } from "../diagnostics/apiKeyDiagnostics";

const BASE_URL = "https://api.assemblyai.com";

export interface AssemblyAiFileTranscriptionOptions {
	apiKey: string;
	audioData: ArrayBuffer;
	speechModels?: string[];
	speakerLabels?: boolean;
	punctuate?: boolean;
	formatText?: boolean;
	keytermsPrompt?: string[];
	pollIntervalMs?: number;
	maxPollMs?: number;
	onProgress?: (status: string) => void;
}

export interface AssemblyAiFileTranscriptionResult {
	transcriptId: string;
	text: string;
	audioUrl: string;
}

export async function transcribeAudioFileWithAssemblyAi(
	opts: AssemblyAiFileTranscriptionOptions
): Promise<AssemblyAiFileTranscriptionResult> {
	const apiKey = normalizeApiKey(opts.apiKey);
	if (!apiKey) {
		throw new Error("Missing AssemblyAI API key.");
	}

	const audioUrl = await uploadAudio(apiKey, opts.audioData);
	const transcriptId = await requestTranscript(apiKey, audioUrl, opts);
	const text = await pollTranscript(apiKey, transcriptId, opts);
	return { transcriptId, text, audioUrl };
}

async function uploadAudio(apiKey: string, audioData: ArrayBuffer): Promise<string> {
	const res = await requestUrl({
		url: `${BASE_URL}/v2/upload`,
		method: "POST",
		contentType: "application/octet-stream",
		headers: { authorization: apiKey },
		body: audioData,
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`AssemblyAI upload failed (${formatResponseError(res)})`);
	}
	const uploadUrl = (res.json as { upload_url?: string } | null)?.upload_url;
	if (!uploadUrl) {
		throw new Error("AssemblyAI upload failed (missing upload URL).");
	}
	return uploadUrl;
}

async function requestTranscript(
	apiKey: string,
	audioUrl: string,
	opts: AssemblyAiFileTranscriptionOptions
): Promise<string> {
	const payload = {
		audio_url: audioUrl,
		speech_models: opts.speechModels ?? ["universal"],
		speaker_labels: opts.speakerLabels ?? true,
		punctuate: opts.punctuate ?? true,
		format_text: opts.formatText ?? true,
	};
	if (opts.keytermsPrompt && opts.keytermsPrompt.length > 0) {
		(payload as { keyterms_prompt?: string[] }).keyterms_prompt = opts.keytermsPrompt;
	}
	const res = await requestUrl({
		url: `${BASE_URL}/v2/transcript`,
		method: "POST",
		contentType: "application/json",
		headers: { authorization: apiKey },
		body: JSON.stringify(payload),
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`AssemblyAI transcript request failed (${formatResponseError(res)})`);
	}
	const transcriptId = (res.json as { id?: string } | null)?.id;
	if (!transcriptId) {
		throw new Error("AssemblyAI transcript request failed (missing transcript id).");
	}
	return transcriptId;
}

async function pollTranscript(
	apiKey: string,
	transcriptId: string,
	opts: AssemblyAiFileTranscriptionOptions
): Promise<string> {
	const pollIntervalMs = Math.max(1000, opts.pollIntervalMs ?? 3000);
	const maxPollMs = Math.max(pollIntervalMs, opts.maxPollMs ?? 12 * 60 * 1000);
	const start = Date.now();

	while (true) {
		const res = await requestUrl({
			url: `${BASE_URL}/v2/transcript/${transcriptId}`,
			method: "GET",
			headers: { authorization: apiKey },
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`AssemblyAI polling failed (${formatResponseError(res)})`);
		}
		const payload = res.json as { status?: string; text?: string; error?: string } | null;
		const status = payload?.status ?? "unknown";
		opts.onProgress?.(status);
		if (status === "completed") {
			return (payload?.text ?? "").trim();
		}
		if (status === "error") {
			const msg = payload?.error || "Unknown error";
			throw new Error(`Transcription failed: ${msg}`);
		}
		if (Date.now() - start > maxPollMs) {
			throw new Error("Transcription timed out while polling AssemblyAI.");
		}
		await sleep(pollIntervalMs);
	}
}

function formatResponseError(res: { status: number; text: string; json: any }): string {
	const text = typeof res.text === "string" ? res.text.trim() : "";
	const jsonPreview = res.json ? JSON.stringify(res.json).slice(0, 240) : "";
	const body = text || jsonPreview || "Unknown error";
	return `status=${res.status} ${body}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
