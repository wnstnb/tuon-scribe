import { App, TFile } from "obsidian";
import { buildRecordingFilename } from "../audio/audioFileUtils";
import { startRecordedAudioCapture, RecordedAudioCaptureHandle } from "../audio/recordedAudioCapture";
import {
	concatSamples,
	decodeAudioDataToBuffer,
	durationMsForSamples,
	encodeWavFromMono,
	resampleAudioBuffer,
	toMonoSamples,
} from "../audio/wavUtils";
import {
	AssemblyAiFileTranscriptionOptions,
	AssemblyAiFileTranscriptionResult,
	transcribeAudioFileWithAssemblyAi,
} from "./assemblyAiFileClient";

export interface RecordedTranscribeServiceOptions {
	app: App;
	getAssemblyAiApiKey: () => string;
	getFileTranscribeConfig?: () => AssemblyAiFileConfig;
	getKeytermsPrompt?: () => Promise<string[]>;
	onStatusText?: (text: string) => void;
	onAudioFrame?: (data: Uint8Array | null) => void;
}

export type AssemblyAiFileConfig = Pick<
	AssemblyAiFileTranscriptionOptions,
	| "speechModels"
	| "speakerLabels"
	| "punctuate"
	| "formatText"
	| "keytermsPrompt"
	| "pollIntervalMs"
	| "maxPollMs"
>;

export interface RecordedTranscriptionResult {
	text: string;
	transcriptId: string;
	audioFile: TFile;
	audioPath: string;
	audioUrl: string;
	durationMs?: number;
}

export class RecordedTranscribeService {
	private readonly app: App;
	private readonly getAssemblyAiApiKey: () => string;
	private readonly getFileTranscribeConfig?: RecordedTranscribeServiceOptions["getFileTranscribeConfig"];
	private readonly getKeytermsPrompt?: RecordedTranscribeServiceOptions["getKeytermsPrompt"];
	private readonly onStatusText?: (text: string) => void;
	private readonly onAudioFrame?: (data: Uint8Array | null) => void;

	private capture: RecordedAudioCaptureHandle | null = null;
	private recording = false;
	private transcribing = false;

	constructor(opts: RecordedTranscribeServiceOptions) {
		this.app = opts.app;
		this.getAssemblyAiApiKey = opts.getAssemblyAiApiKey;
		this.getFileTranscribeConfig = opts.getFileTranscribeConfig;
		this.getKeytermsPrompt = opts.getKeytermsPrompt;
		this.onStatusText = opts.onStatusText;
		this.onAudioFrame = opts.onAudioFrame;
	}

	get isRecording() {
		return this.recording;
	}

	get isTranscribing() {
		return this.transcribing;
	}

	async startRecording(): Promise<void> {
		if (this.recording || this.transcribing) {
			throw new Error("Recorded transcription is already running.");
		}
		const apiKey = this.getAssemblyAiApiKey()?.trim();
		if (!apiKey) {
			throw new Error("Missing AssemblyAI API key. Set it in plugin settings.");
		}
		this.onStatusText?.("Recording audio…");
		try {
			this.capture = await startRecordedAudioCapture({
				onAudioFrame: this.onAudioFrame,
			});
			this.recording = true;
		} catch (err) {
			this.onStatusText?.("");
			throw err;
		}
	}

	cancelRecording() {
		if (!this.recording || !this.capture) return;
		const capture = this.capture;
		this.capture = null;
		this.recording = false;
		try {
			void capture.stop();
		} catch {}
		this.onAudioFrame?.(null);
		this.onStatusText?.("");
	}

	async stopAndTranscribe(opts: {
		sourcePath?: string;
		existingAudioPath?: string;
	}): Promise<RecordedTranscriptionResult> {
		if (!this.recording || !this.capture) {
			throw new Error("No recorded transcription in progress.");
		}
		const apiKey = this.getAssemblyAiApiKey()?.trim();
		if (!apiKey) {
			throw new Error("Missing AssemblyAI API key. Set it in plugin settings.");
		}
		this.recording = false;
		this.onStatusText?.("Saving recording…");
		const capture = this.capture;
		this.capture = null;

		try {
			this.transcribing = true;
			const recorded = await capture.stop();
			this.onAudioFrame?.(null);
			const recordedData = await recorded.blob.arrayBuffer();
			const combined = await this.buildCombinedWav({
				newAudioData: recordedData,
				existingAudioPath: opts.existingAudioPath,
			});
			const audioFile = await this.saveAudioRecording(
				combined.wavData,
				opts.sourcePath,
				opts.existingAudioPath
			);
			this.onStatusText?.("Uploading audio…");
			const config = this.getFileTranscribeConfig?.() ?? {};
			const result = await this.transcribeAudio(apiKey, combined.wavData, config);
			this.onStatusText?.("");
			return {
				text: result.text,
				transcriptId: result.transcriptId,
				audioFile,
				audioPath: audioFile.path,
				audioUrl: result.audioUrl,
				durationMs: combined.durationMs,
			};
		} finally {
			this.transcribing = false;
			this.onStatusText?.("");
		}
	}

	async transcribeExistingFile(
		file: TFile,
		opts?: { sourcePath?: string }
	): Promise<RecordedTranscriptionResult> {
		const apiKey = this.getAssemblyAiApiKey()?.trim();
		if (!apiKey) {
			throw new Error("Missing AssemblyAI API key. Set it in plugin settings.");
		}
		if (this.transcribing) {
			throw new Error("Recorded transcription is already running.");
		}
		this.transcribing = true;
		this.onStatusText?.("Uploading audio…");
		try {
			const audioData = await this.app.vault.readBinary(file);
			const config = this.getFileTranscribeConfig?.() ?? {};
			const result = await this.transcribeAudio(apiKey, audioData, config);
			return {
				text: result.text,
				transcriptId: result.transcriptId,
				audioFile: file,
				audioPath: file.path,
				audioUrl: result.audioUrl,
			};
		} finally {
			this.transcribing = false;
			this.onStatusText?.("");
		}
	}

	private async transcribeAudio(
		apiKey: string,
		audioData: ArrayBuffer,
		config: AssemblyAiFileConfig
	): Promise<AssemblyAiFileTranscriptionResult> {
		let keytermsPrompt: string[] | undefined;
		try {
			keytermsPrompt = await this.getKeytermsPrompt?.();
		} catch {
			keytermsPrompt = undefined;
		}
		const keytermsPayload =
			keytermsPrompt && keytermsPrompt.length > 0
				? { keytermsPrompt }
				: {};
		return transcribeAudioFileWithAssemblyAi({
			apiKey,
			audioData,
			...config,
			...keytermsPayload,
			onProgress: (status) => {
				const cleaned = status ? status.replace(/_/g, " ") : "processing";
				this.onStatusText?.(`Transcribing (${cleaned})…`);
			},
		});
	}

	private async saveAudioRecording(
		audioData: ArrayBuffer,
		sourcePath?: string,
		existingAudioPath?: string
	): Promise<TFile> {
		const existing = existingAudioPath
			? this.app.vault.getAbstractFileByPath(existingAudioPath)
			: null;
		if (existing instanceof TFile && existing.extension.toLowerCase() === "wav") {
			await this.app.vault.modifyBinary(existing, audioData);
			return existing;
		}
		const filename = buildRecordingFilename("wav");
		const path = await this.app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
		return this.app.vault.createBinary(path, audioData);
	}

	private async buildCombinedWav(opts: {
		newAudioData: ArrayBuffer;
		existingAudioPath?: string;
	}): Promise<{ wavData: ArrayBuffer; durationMs: number }> {
		this.onStatusText?.("Preparing recording…");
		const newBuffer = await decodeAudioDataToBuffer(opts.newAudioData);
		let existingBuffer: AudioBuffer | null = null;
		if (opts.existingAudioPath?.trim()) {
			const existingFile = this.app.vault.getAbstractFileByPath(opts.existingAudioPath);
			if (!(existingFile instanceof TFile)) {
				throw new Error("Existing recording file not found.");
			}
			const existingData = await this.app.vault.readBinary(existingFile);
			existingBuffer = await decodeAudioDataToBuffer(existingData);
		}

		const targetSampleRate = existingBuffer?.sampleRate ?? newBuffer.sampleRate;
		const normalizedExisting = existingBuffer
			? await resampleAudioBuffer(existingBuffer, targetSampleRate)
			: null;
		const normalizedNew = await resampleAudioBuffer(newBuffer, targetSampleRate);

		const existingSamples = normalizedExisting ? toMonoSamples(normalizedExisting) : null;
		const newSamples = toMonoSamples(normalizedNew);
		const combinedSamples = existingSamples
			? concatSamples([existingSamples, newSamples])
			: newSamples;

		const wavData = encodeWavFromMono(combinedSamples, targetSampleRate);
		const durationMs = durationMsForSamples(combinedSamples.length, targetSampleRate);
		return { wavData, durationMs };
	}
}
