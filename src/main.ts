import {
	Editor,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	setIcon,
} from "obsidian";
import { DEFAULT_SETTINGS, TuonScribeSettingTab, TuonScribeSettings } from "./settings";
import { openRouterChatCompletion } from "./ai/openrouter";
import { buildSystemPrompt, buildUserPrompt, NotesAction } from "./ai/voiceSummaryPrompts";
import { LiveTranscribeService } from "./transcribe/liveTranscribeService";
import { RecordedTranscribeService } from "./transcribe/recordedTranscribeService";
import type { RecordedTranscriptionResult } from "./transcribe/recordedTranscribeService";
import {
	buildRecordingStartMarker,
	buildRecordingStopMarker,
} from "./transcribe/transcriptMarkers";
import { AudioVisualizer } from "./ui/audioVisualizer";
import { showSelectionOverlay } from "./ui/selectionOverlay";
import { EditorView } from "@codemirror/view";
import {
	buildVoiceSummaryFence,
	createVoiceSummaryBlockData,
	VOICE_SUMMARY_BLOCK_TYPE,
	RecordingMode,
} from "./voiceSummary/voiceSummaryBlock";
import { renderVoiceSummaryBlock } from "./ui/voiceSummaryBlockRenderer";
import {
	showTestResultToast,
	testAssemblyAiApiKey,
	testOpenRouterApiKey,
} from "./diagnostics/apiKeyDiagnostics";
import { AudioFilePickerModal } from "./ui/audioFilePickerModal";
import { isAudioFile } from "./audio/audioFileUtils";
import {
	appendVocabTerm,
	ensureVocabFile as ensureVocabFileOnDisk,
	readVocabTerms,
	vocabPaths,
} from "./vocab/vocabFile";

const OPENROUTER_APP_TITLE = "Tuon Scribe";

type RecordingPhase = "recording" | "transcribing" | null;
type RecordingState = {
	running: boolean;
	blockId: string | null;
	mode: RecordingMode | null;
	phase: RecordingPhase;
};

export default class TuonScribePlugin extends Plugin {
	settings: TuonScribeSettings;
	private liveTranscribe: LiveTranscribeService | null = null;
	private recordedTranscribe: RecordedTranscribeService | null = null;
	private statusBarItemEl: HTMLElement | null = null;
	private widgetEl: HTMLDivElement | null = null;
	private widgetButtonEl: HTMLButtonElement | null = null;
	private widgetTranscriptEl: HTMLDivElement | null = null;
	private widgetVisualizerCanvasEl: HTMLCanvasElement | null = null;
	private widgetTimerEl: HTMLSpanElement | null = null;
	private widgetTimerIntervalId: number | null = null;
	private widgetTimerStart: number | null = null;
	private editorRecordingStartedAt: Date | null = null;
	private widgetRunning = false;
	private widgetLastVisualizerDraw = 0;
	private widgetRibbonEl: HTMLElement | null = null;
	private widgetModeSelectEl: HTMLSelectElement | null = null;
	private widgetRecordingMode: RecordingMode = "stream";
	private audioVisualizer: AudioVisualizer | null = null;
	private readonly widgetMinWidth = 220;
	private readonly widgetMaxWidth = 390;
	private streamRecordingBlockId: string | null = null;
	private fileRecordingBlockId: string | null = null;
	private recordedTranscribeSourcePath: string | null = null;
	private recordingListeners = new Set<
		(state: RecordingState) => void
	>();
	private transcriptPreviewListeners = new Set<
		(preview: string, state: RecordingState) => void
	>();
	private audioFrameListeners = new Set<
		(data: Uint8Array | null, state: RecordingState) => void
	>();

	async onload() {
		await this.loadSettings();
		void this.initializeVocabFile();
		this.widgetRecordingMode = "stream";

		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.setText("");

		this.liveTranscribe = new LiveTranscribeService({
			app: this.app,
			getAssemblyAiApiKey: () => this.settings.assemblyAiApiKey,
			getAssemblyAiConfig: () => ({
				sampleRate: this.settings.assemblyAiSampleRate,
				chunkSizeSamples: this.settings.assemblyAiChunkSizeSamples,
				encoding: this.settings.assemblyAiEncoding,
				formatTurns: this.settings.assemblyAiFormatTurns,
				endOfTurnConfidenceThreshold: this.settings.assemblyAiEndOfTurnConfidenceThreshold,
				minEndOfTurnSilenceMs: this.settings.assemblyAiMinEndOfTurnSilenceMs,
				maxTurnSilenceMs: this.settings.assemblyAiMaxTurnSilenceMs,
			}),
			getKeytermsPrompt: () => this.loadKeytermsPrompt(),
			onStatusText: (t) => this.updateStatusText(t),
			onRunningChange: (running) => {
				const wasBlockRecording = Boolean(this.streamRecordingBlockId);
				this.updateWidgetState();
				if (running) {
					if (!wasBlockRecording) {
						this.handleEditorRecordingStart();
					}
				} else {
					if (!wasBlockRecording) {
						this.handleEditorRecordingStop();
					}
					this.streamRecordingBlockId = null;
				}
				this.notifyRecordingChange();
				if (!running) {
					this.notifyAudioFrame(null);
				}
			},
			onAudioFrame: (data) => {
				this.updateVisualizer(data);
				this.notifyAudioFrame(data);
			},
		});

		this.recordedTranscribe = new RecordedTranscribeService({
			app: this.app,
			getAssemblyAiApiKey: () => this.settings.assemblyAiApiKey,
			getFileTranscribeConfig: () => ({
				speechModels: ["universal"],
				speakerLabels: true,
				punctuate: true,
				formatText: true,
			}),
			getKeytermsPrompt: () => this.loadKeytermsPrompt(),
			onStatusText: (text) => this.updateRecordedStatusText(text),
			onAudioFrame: (data) => {
				this.updateVisualizer(data);
				this.notifyAudioFrame(data);
			},
		});

		if (this.settings.showWidget) {
			this.initLiveWidget();
		}
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				window.setTimeout(() => {
					this.refreshActiveMarkdownViewIfScribeBlock(file);
				}, 0);
			})
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.attachWidgetToActiveEditor();
			})
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.updateWidgetOffset();
				this.updateWidgetSize();
			})
		);
		this.registerDomEvent(window, "resize", () => {
			this.updateWidgetOffset();
			this.updateWidgetSize();
		});

		this.widgetRibbonEl = this.createWidgetRibbon();
		this.updateRibbonState(this.settings.showWidget);

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const selection = editor.getSelection()?.trim();
				if (!selection) return;
				menu.addItem((item) => {
					item.setTitle("Summarize selection")
						.setIcon("sparkles")
						.onClick(() => {
							void this.runNotesAction(editor, "summary");
						});
				});
				menu.addItem((item) => {
					item.setTitle("Prettify selection")
						.setIcon("wand-2")
						.onClick(() => {
							void this.runNotesAction(editor, "prettify");
						});
				});
				menu.addItem((item) => {
					item.setTitle("Add to vocab")
						.setIcon("book-plus")
						.onClick(() => {
							void this.addSelectionToVocab(selection);
						});
				});
			})
		);

		this.addCommand({
			id: "tuon-live-transcription-toggle",
			name: "Tuon: Toggle live transcription",
			callback: () => this.liveTranscribe?.toggle(),
		});

		this.addCommand({
			id: "tuon-live-transcription-start",
			name: "Tuon: Start live transcription",
			callback: () => void this.liveTranscribe?.start(),
		});

		this.addCommand({
			id: "tuon-live-transcription-stop",
			name: "Tuon: Stop live transcription",
			callback: () => this.liveTranscribe?.stop(),
		});

		this.addCommand({
			id: "tuon-recorded-transcription-toggle",
			name: "Tuon: Toggle recorded audio transcription",
			callback: () => {
				new Notice("Recorded audio is available inside scribe blocks only.");
			},
		});

		this.addCommand({
			id: "tuon-recorded-transcription-start",
			name: "Tuon: Start recorded audio transcription",
			callback: () => {
				new Notice("Recorded audio is available inside scribe blocks only.");
			},
		});

		this.addCommand({
			id: "tuon-recorded-transcription-stop",
			name: "Tuon: Stop recorded audio transcription",
			callback: () => {
				new Notice("Recorded audio is available inside scribe blocks only.");
			},
		});

		this.addCommand({
			id: "tuon-transcribe-audio-file",
			name: "Tuon: Transcribe audio file (AssemblyAI)",
			callback: () => void this.transcribeAudioFileFromVault(),
		});

		this.addCommand({
			id: "tuon-summarize-selection",
			name: "Summarize selection",
			icon: "sparkles",
			editorCallback: async (editor: Editor) => {
				await this.runNotesAction(editor, "summary");
			},
		});

		this.addCommand({
			id: "tuon-prettify-selection",
			name: "Prettify selection",
			icon: "wand-2",
			editorCallback: async (editor: Editor) => {
				await this.runNotesAction(editor, "prettify");
			},
		});

		this.addCommand({
			id: "tuon-add-to-vocab",
			name: "Add selection to vocab",
			icon: "book-open-check",
			editorCallback: async (editor: Editor) => {
				const selection = editor.getSelection()?.trim();
				if (!selection) {
					new Notice("Select some text first.");
					return;
				}
				await this.addSelectionToVocab(selection);
			},
		});

		this.addCommand({
			id: "tuon-insert-voice-summary-block",
			name: "Insert scribe block",
			editorCallback: (editor: Editor) => {
				this.insertVoiceSummaryBlock(editor);
			},
		});

		this.addCommand({
			id: "tuon-test-assemblyai-key",
			name: "Test AssemblyAI API key",
			callback: () => void this.testAssemblyAiKey(),
		});

		this.addCommand({
			id: "tuon-test-openrouter-key",
			name: "Test OpenRouter API key",
			callback: () => void this.testOpenRouterKey(),
		});

		this.registerMarkdownCodeBlockProcessor(
			VOICE_SUMMARY_BLOCK_TYPE,
			(source, el, ctx) => {
				const child = new MarkdownRenderChild(el);
				const unsubscribe = renderVoiceSummaryBlock({
					app: this.app,
					el,
					source,
					sourcePath: ctx.sourcePath,
					component: child,
					actions: {
						getRecordingState: () => this.getRecordingState(),
						onRecordingChange: (handler) => this.onRecordingChange(handler),
						onTranscriptPreview: (handler) => this.onTranscriptPreview(handler),
						onAudioFrame: (handler) => this.onAudioFrame(handler),
						getInteractionSettings: () => ({
							autoScrollTranscript: this.settings.autoScrollTranscript,
							autoSwitchToTranscript: this.settings.autoSwitchToTranscript,
						}),
						getTimestampSettings: () => ({
							scribeBlockTimestamps: this.settings.scribeBlockTimestamps,
						}),
						startRecordingForBlock: (opts) => this.startRecordingForBlock(opts),
						stopRecordingForBlock: (opts) => this.stopRecordingForBlock(opts),
						summarizeTranscript: (transcript) =>
							this.summarizeTranscript(transcript),
						prettifyTranscript: (transcript) =>
							this.prettifyTranscript(transcript),
					},
				});
				child.onunload = () => {
					if (unsubscribe) unsubscribe();
				};
				ctx.addChild(child);
			}
		);

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new TuonScribeSettingTab(this.app, this));
	}

	onunload() {
		try {
			this.liveTranscribe?.stop();
		} catch {}
		try {
			this.recordedTranscribe?.cancelRecording();
		} catch {}
		this.statusBarItemEl?.setText("");
		this.destroyLiveWidget();
		this.widgetRibbonEl?.remove();
		this.widgetRibbonEl = null;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<TuonScribeSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async initializeVocabFile() {
		try {
			await ensureVocabFileOnDisk(this.app);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Unable to create vocab file: ${msg}`);
		}
	}

	private async loadKeytermsPrompt(): Promise<string[]> {
		try {
			return await readVocabTerms(this.app);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Unable to read vocab file: ${msg}`);
			return [];
		}
	}

	private async addSelectionToVocab(selection: string) {
		try {
			const result = await appendVocabTerm(this.app, selection);
			if (result.status === "added") {
				new Notice(`Added to vocab: ${result.term ?? "term"}`);
				return;
			}
			if (result.status === "exists") {
				new Notice(`Already in vocab: ${result.term ?? "term"}`);
				return;
			}
			if (result.status === "too-long") {
				new Notice("Vocabulary terms must be 50 characters or fewer.");
				return;
			}
			new Notice("Nothing to add to vocab.");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to update ${vocabPaths.file}: ${msg}`);
		}
	}

	private updateStatusText(text: string) {
		const preview = (text || "").trim();
		this.notifyTranscriptPreview(preview);
		if (this.streamRecordingBlockId || this.fileRecordingBlockId) return;
		if (this.widgetTranscriptEl) {
			this.widgetTranscriptEl.textContent = preview || "Say something to begin…";
			this.scrollWidgetTranscriptToBottom();
		}
	}

	private updateRecordedStatusText(text: string) {
		if (this.liveTranscribe?.isRunning) return;
		const trimmed = (text || "").trim();
		this.statusBarItemEl?.setText(trimmed);
		if (this.widgetTranscriptEl && !this.streamRecordingBlockId && !this.fileRecordingBlockId) {
			if (this.widgetRecordingMode === "file") {
				this.widgetTranscriptEl.textContent =
					trimmed || "Record audio to begin…";
				this.scrollWidgetTranscriptToBottom();
			}
		}
	}

	private refreshActiveMarkdownViewIfScribeBlock(file: TFile | null) {
		if (!file) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const cache = this.app.metadataCache.getFileCache(file) as
			| { sections?: Array<{ type?: string; id?: string }> }
			| null
			| undefined;
		const hasScribeBlock =
			cache?.sections?.some(
				(section) => section.type === "code" && section.id === VOICE_SUMMARY_BLOCK_TYPE
			) ?? false;
		if (!hasScribeBlock) return;
		const preview = (view as { previewMode?: { rerender?: (force?: boolean) => void } })
			.previewMode;
		preview?.rerender?.(true);
	}

	private getActiveEditor(): Editor | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
	}

	private insertEditorMarker(marker: string) {
		const editor = this.getActiveEditor();
		if (!editor) return;
		const cursor = editor.getCursor();
		const prefix = cursor.ch === 0 ? "" : "\n\n";
		const insertion = `${prefix}${marker}\n\n`;
		editor.replaceRange(insertion, cursor);
		editor.setCursor(advanceCursor(cursor, insertion));
	}

	private handleEditorRecordingStart() {
		if (this.editorRecordingStartedAt) return;
		const startedAt = new Date();
		this.editorRecordingStartedAt = startedAt;
		if (!this.settings.editorTranscriptionTimestamps) return;
		this.insertEditorMarker(buildRecordingStartMarker(startedAt));
	}

	private handleEditorRecordingStop() {
		if (!this.editorRecordingStartedAt) return;
		const stoppedAt = new Date();
		const startedAt = this.editorRecordingStartedAt;
		this.editorRecordingStartedAt = null;
		if (!this.settings.editorTranscriptionTimestamps) return;
		this.insertEditorMarker(buildRecordingStopMarker(stoppedAt, startedAt));
	}

	private getEditorView(editor: Editor): EditorView | null {
		const maybe = (editor as any)?.cm;
		if (maybe && typeof maybe.coordsAtPos === "function") {
			return maybe as EditorView;
		}
		const nested = (editor as any)?.cm?.cm;
		if (nested && typeof nested.coordsAtPos === "function") {
			return nested as EditorView;
		}
		return null;
	}

	private scrollWidgetTranscriptToBottom() {
		const el = this.widgetTranscriptEl;
		if (!el) return;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
	}

	private updateWidgetState() {
		const state = this.getRecordingState();
		const isRecording =
			(this.liveTranscribe?.isRunning ?? false) ||
			(this.recordedTranscribe?.isRecording ?? false);
		const fileBusy = this.recordedTranscribe?.isTranscribing ?? false;
		const widgetRunning = isRecording && !state.blockId;
		const isBlocked = (isRecording || fileBusy) && !!state.blockId;
		this.widgetRunning = widgetRunning;
		if (this.widgetModeSelectEl) {
			this.widgetModeSelectEl.value = this.widgetRecordingMode;
			this.widgetModeSelectEl.disabled = state.running || fileBusy;
		}
		if (this.widgetButtonEl) {
			this.updateWidgetButtonIcon(widgetRunning);
			this.widgetButtonEl.disabled = isBlocked || fileBusy;
			this.widgetButtonEl.style.background = widgetRunning
				? "var(--color-red)"
				: "var(--background-secondary)";
			this.widgetButtonEl.style.color = widgetRunning ? "white" : "var(--text-normal)";
		}
		if (this.liveTranscribe?.isRunning) {
			this.statusBarItemEl?.setText("Listening…");
		} else if (!this.recordedTranscribe?.isRecording && !this.recordedTranscribe?.isTranscribing) {
			this.statusBarItemEl?.setText("");
		}
		if (this.widgetEl) {
			this.widgetEl.dataset.running = widgetRunning ? "true" : "false";
		}
		if (widgetRunning) {
			this.startWidgetTimer();
		} else {
			this.stopWidgetTimer();
			this.audioVisualizer?.update(null, false);
			if (this.widgetTranscriptEl && !state.running && !fileBusy) {
				const placeholder =
					this.widgetRecordingMode === "file"
						? "Record audio to begin…"
						: "Say something to begin…";
				this.widgetTranscriptEl.textContent = placeholder;
			}
		}
	}

	setWidgetVisible(visible: boolean) {
		if (visible) {
			if (!this.widgetEl) {
				this.initLiveWidget();
			} else {
				this.attachWidgetToActiveEditor();
			}
		} else {
			this.destroyLiveWidget();
		}
		this.updateRibbonState(visible);
	}

	private createWidgetRibbon(): HTMLElement | null {
		const toggle = () => {
			const next = !this.settings.showWidget;
			this.settings.showWidget = next;
			void this.saveSettings();
			this.setWidgetVisible(next);
		};

		const tryAdd = (icon: string) => {
			try {
				return this.addRibbonIcon(icon, "Tuon: Toggle live widget", toggle);
			} catch {
				return null;
			}
		};

		return tryAdd("mic-vocal") ?? tryAdd("mic");
	}

	private updateRibbonState(visible: boolean) {
		if (!this.widgetRibbonEl) return;
		this.widgetRibbonEl.toggleClass("is-active", visible);
		this.widgetRibbonEl.setAttr("aria-pressed", visible ? "true" : "false");
		this.widgetRibbonEl.setAttr("aria-label", visible ? "Hide live widget" : "Show live widget");
	}

	private initLiveWidget() {
		if (this.widgetEl) return;
		const container = document.createElement("div");
		container.className = "tuon-live-transcribe-widget";
		container.setAttr("aria-live", "polite");
		container.dataset.running = "false";

		const header = document.createElement("div");
		header.style.display = "flex";
		header.style.alignItems = "center";
		header.style.justifyContent = "space-between";
		header.style.gap = "8px";

		const visualizerWrap = document.createElement("div");
		visualizerWrap.style.display = "flex";
		visualizerWrap.style.alignItems = "center";
		visualizerWrap.style.gap = "8px";

		const canvas = document.createElement("canvas");
		canvas.width = 120;
		canvas.height = 24;
		canvas.style.width = "120px";
		canvas.style.height = "24px";
		canvas.style.borderRadius = "6px";
		canvas.style.background = "var(--background-secondary)";

		const timer = document.createElement("span");
		timer.textContent = "00:00";
		timer.style.fontSize = "12px";
		timer.style.fontVariantNumeric = "tabular-nums";
		timer.style.opacity = "0.9";

		visualizerWrap.appendChild(canvas);
		visualizerWrap.appendChild(timer);

		const controls = document.createElement("div");
		controls.style.display = "flex";
		controls.style.alignItems = "center";
		controls.style.gap = "6px";

		const button = document.createElement("button");
		button.type = "button";
		button.style.fontSize = "12px";
		button.style.width = "32px";
		button.style.height = "32px";
		button.style.padding = "0";
		button.style.borderRadius = "9999px";
		button.style.border = "1px solid var(--background-modifier-border)";
		button.style.background = "var(--background-secondary)";
		button.style.color = "var(--text-normal)";
		button.style.cursor = "pointer";
		button.style.display = "flex";
		button.style.alignItems = "center";
		button.style.justifyContent = "center";

		this.registerDomEvent(button, "click", () => {
			const state = this.getRecordingState();
			if (state.running && state.blockId) {
				new Notice("Recording is active in a scribe block.");
				return;
			}
			void this.toggleWidgetRecording();
		});

		header.appendChild(visualizerWrap);
		controls.appendChild(button);
		header.appendChild(controls);

		const transcript = document.createElement("div");
		transcript.className = "tuon-live-transcribe-widget__transcript";
		transcript.textContent = "Say something to begin…";
		transcript.style.fontSize = "12px";
		transcript.style.lineHeight = "1.4";
		transcript.style.opacity = "0.9";
		transcript.style.marginBottom = "6px";
		transcript.style.whiteSpace = "pre-wrap";
		transcript.style.wordBreak = "break-word";
		transcript.style.maxHeight = "64px";
		transcript.style.overflow = "auto";
		transcript.style.scrollbarWidth = "none";
		(transcript.style as CSSStyleDeclaration & { msOverflowStyle?: string }).msOverflowStyle = "none";

		// Minimal inline styling to float in editor view.
		container.style.position = "absolute";
		container.style.left = "50%";
		container.style.transform = "translateX(-50%)";
		container.style.zIndex = "1000";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.alignItems = "stretch";
		container.style.gap = "6px";
		container.style.padding = "10px 12px";
		container.style.borderRadius = "12px";
		container.style.background = "var(--background-primary)";
		container.style.boxShadow = "0 6px 20px rgba(0,0,0,0.2)";
		container.style.border = "1px solid var(--background-modifier-border)";
		container.style.backdropFilter = "blur(6px)";
		container.style.maxWidth = `${this.widgetMaxWidth}px`;
		container.style.minWidth = `${this.widgetMinWidth}px`;

		container.appendChild(transcript);
		container.appendChild(header);

		this.widgetEl = container;
		this.widgetButtonEl = button;
		this.widgetModeSelectEl = null;
		this.widgetTranscriptEl = transcript;
		this.widgetVisualizerCanvasEl = canvas;
		this.widgetTimerEl = timer;
		this.audioVisualizer = new AudioVisualizer({
			canvas,
			barWidth: 3,
			barGap: 1,
			sensitivity: 6,
		});
		this.updateWidgetButtonIcon(false);
		this.audioVisualizer.update(null, false);

		this.attachWidgetToActiveEditor();
		this.updateWidgetOffset();
		this.updateWidgetSize();
	}

	private destroyLiveWidget() {
		if (this.widgetEl) {
			this.widgetEl.remove();
		}
		this.widgetEl = null;
		this.widgetButtonEl = null;
		this.widgetModeSelectEl = null;
		this.widgetTranscriptEl = null;
		this.widgetVisualizerCanvasEl = null;
		this.widgetTimerEl = null;
		this.audioVisualizer = null;
		this.stopWidgetTimer();
	}

	private attachWidgetToActiveEditor() {
		if (!this.widgetEl) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const host = view?.contentEl;
		if (!host) return;

		// Ensure host is positionable so our absolute widget sits within it.
		const style = getComputedStyle(host);
		if (style.position === "static") {
			host.style.position = "relative";
		}

		if (this.widgetEl.parentElement !== host) {
			this.widgetEl.remove();
			host.appendChild(this.widgetEl);
		}
		this.updateWidgetOffset();
		this.updateWidgetSize();
	}

	private isMobileLayout() {
		return (
			document.body.classList.contains("is-mobile") ||
			document.documentElement.classList.contains("is-mobile")
		);
	}

	private getBottomOverlayInset() {
		if (!this.widgetEl || !this.isMobileLayout()) return 0;
		const host = this.widgetEl.parentElement;
		if (!host) return 0;
		const viewportHeight =
			window.visualViewport?.height ??
			document.documentElement.clientHeight ??
			window.innerHeight;
		const viewportWidth =
			window.visualViewport?.width ??
			document.documentElement.clientWidth ??
			window.innerWidth;
		if (!viewportHeight || !viewportWidth) return 0;

		const sampleY = Math.max(0, Math.floor(viewportHeight - 1));
		const sampleRatios = [0.2, 0.5, 0.8];
		let maxInset = 0;

		for (const ratio of sampleRatios) {
			const x = Math.min(
				Math.max(0, Math.floor(viewportWidth * ratio)),
				Math.max(0, Math.floor(viewportWidth - 1))
			);
			const el = document.elementFromPoint(x, sampleY) as HTMLElement | null;
			if (!el) continue;
			if (this.widgetEl.contains(el) || host.contains(el)) continue;
			const rect = el.getBoundingClientRect();
			if (rect.height < 24) continue;
			if (rect.bottom < viewportHeight - 1) continue;
			const inset = Math.max(0, viewportHeight - rect.top);
			if (inset > maxInset) maxInset = inset;
		}

		return Math.ceil(maxInset);
	}

	private updateWidgetOffset() {
		if (!this.widgetEl) return;
		const statusBar = document.querySelector(".status-bar") as HTMLElement | null;
		const statusBarHeight = statusBar?.getBoundingClientRect().height ?? 0;
		const gutter = 8;
		const minBottom = 16;
		const overlayInset = this.getBottomOverlayInset();
		const bottom = Math.max(minBottom, Math.ceil(statusBarHeight + gutter + overlayInset));
		this.widgetEl.style.bottom = `${bottom}px`;
		this.updateWidgetSize();
	}

	private updateWidgetSize() {
		if (!this.widgetEl) return;
		const host = this.widgetEl.parentElement;
		if (!host) return;
		const hostWidth = host.getBoundingClientRect().width || 0;
		const maxAllowed = Math.max(0, hostWidth - 16);
		const minAllowed = Math.min(this.widgetMinWidth, maxAllowed);
		const target = Math.round(
			Math.min(this.widgetMaxWidth, maxAllowed, Math.max(minAllowed, hostWidth * 0.7))
		);
		this.widgetEl.style.width = `${target}px`;
	}

	private updateWidgetButtonIcon(running: boolean) {
		if (!this.widgetButtonEl) return;
		this.widgetButtonEl.textContent = "";
		setIcon(this.widgetButtonEl, running ? "square" : "mic");
		this.widgetButtonEl.setAttr(
			"aria-label",
			running ? "Stop recording" : "Start recording"
		);
		this.widgetButtonEl.setAttr(
			"title",
			running ? "Stop recording" : "Start recording"
		);
	}

	private startWidgetTimer() {
		if (this.widgetTimerIntervalId !== null) return;
		this.widgetTimerStart = Date.now();
		this.widgetTimerIntervalId = window.setInterval(() => {
			if (!this.widgetTimerEl || !this.widgetTimerStart) return;
			const elapsedMs = Date.now() - this.widgetTimerStart;
			this.widgetTimerEl.textContent = formatTimer(elapsedMs);
		}, 1000);
	}

	private stopWidgetTimer() {
		if (this.widgetTimerIntervalId !== null) {
			clearInterval(this.widgetTimerIntervalId);
			this.widgetTimerIntervalId = null;
		}
		this.widgetTimerStart = null;
		if (this.widgetTimerEl) {
			this.widgetTimerEl.textContent = "00:00";
		}
	}

	private updateVisualizer(data: Uint8Array | null) {
		if (!this.audioVisualizer) return;
		const now = Date.now();
		if (now - this.widgetLastVisualizerDraw < 33) return; // ~30fps
		this.widgetLastVisualizerDraw = now;
		this.audioVisualizer.update(data, this.widgetRunning);
	}

	async testAssemblyAiKey() {
		const res = await testAssemblyAiApiKey(this.settings.assemblyAiApiKey);
		showTestResultToast(res);
	}

	async testOpenRouterKey() {
		const res = await testOpenRouterApiKey({
			apiKey: this.settings.openRouterApiKey,
			model: this.settings.openRouterModel,
			referer: this.settings.openRouterReferer,
			appTitle: OPENROUTER_APP_TITLE,
		});
		showTestResultToast(res);
	}

	private async runNotesAction(editor: Editor, action: NotesAction) {
		const selectionRaw = editor.getSelection() ?? "";
		const selection = selectionRaw.trim();
		if (!selection) {
			new Notice("Select some text first.");
			return;
		}
		if (!this.settings.openRouterApiKey?.trim()) {
			new Notice("Missing OpenRouter API key. Set it in plugin settings.");
			return;
		}

		// Capture the original selection range immediately so we can replace it deterministically,
		// even if the user clicks elsewhere while the request is in flight.
		const fromPos = editor.getCursor("from");
		const toPos = editor.getCursor("to");
		const fromOffset = editor.posToOffset(fromPos);
		const toOffset = editor.posToOffset(toPos);
		const selectionStart = Math.min(fromOffset, toOffset);
		const selectionEnd = Math.max(fromOffset, toOffset);

		const system = this.getSystemPrompt(action);
		const prompt = buildUserPrompt({
			action,
			transcription: selection,
			// Keep timestamp out for now (optional) to avoid timezone surprises.
		});

		const view = this.getEditorView(editor);
		const label = action === "summary" ? "Summarizing…" : "Prettifying…";
		const hideOverlay = view
			? showSelectionOverlay(view, selectionStart, selectionEnd, label)
			: null;

		try {
			new Notice(action === "summary" ? "Summarizing…" : "Prettifying…");
			const out = await openRouterChatCompletion(
				{
					apiKey: this.settings.openRouterApiKey,
					model: this.settings.openRouterModel,
					referer: this.settings.openRouterReferer,
					appTitle: OPENROUTER_APP_TITLE,
				},
				{
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: prompt },
					],
					temperature: action === "summary" ? 0.4 : 0.2,
				}
			);

			const currentRange = editor.getRange(
				editor.offsetToPos(selectionStart),
				editor.offsetToPos(selectionEnd)
			);
			const rangeStillMatches = currentRange.trim() === selection;

			if (action === "prettify") {
				if (rangeStillMatches) {
					editor.replaceRange(
						out,
						editor.offsetToPos(selectionStart),
						editor.offsetToPos(selectionEnd)
					);
				} else {
					new Notice("Selection changed while prettifying; inserting result at cursor.");
					editor.replaceSelection(out);
				}
			} else {
				const cleaned = stripRedundantSummaryHeading(out);
				const replacement = `${selection}\n\n---\n\n${cleaned}\n`;
				if (rangeStillMatches) {
					editor.replaceRange(
						replacement,
						editor.offsetToPos(selectionStart),
						editor.offsetToPos(selectionEnd)
					);
				} else {
					new Notice("Selection changed while summarizing; inserting summary at cursor.");
					editor.replaceSelection(`---\n\n${cleaned}\n`);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`AI request failed: ${msg}`);
		} finally {
			hideOverlay?.();
		}
	}

	private insertVoiceSummaryBlock(editor: Editor) {
		const data = createVoiceSummaryBlockData();
		data.recordingMode = this.settings.recordingModeDefault ?? "stream";
		const fence = buildVoiceSummaryFence(data);
		const cursor = editor.getCursor();
		editor.replaceRange(`${fence}\n\n`, cursor);
	}

	private getRecordingState(): RecordingState {
		if (this.liveTranscribe?.isRunning) {
			return {
				running: true,
				blockId: this.streamRecordingBlockId,
				mode: "stream",
				phase: "recording",
			};
		}
		if (this.recordedTranscribe?.isRecording) {
			return {
				running: true,
				blockId: this.fileRecordingBlockId,
				mode: "file",
				phase: "recording",
			};
		}
		if (this.recordedTranscribe?.isTranscribing) {
			return {
				running: true,
				blockId: this.fileRecordingBlockId,
				mode: "file",
				phase: "transcribing",
			};
		}
		return { running: false, blockId: null, mode: null, phase: null };
	}

	private onRecordingChange(
		handler: (state: RecordingState) => void
	): () => void {
		this.recordingListeners.add(handler);
		return () => this.recordingListeners.delete(handler);
	}

	private notifyRecordingChange() {
		const state = this.getRecordingState();
		this.updateWidgetState();
		for (const handler of this.recordingListeners) {
			handler(state);
		}
	}

	private onAudioFrame(
		handler: (
			data: Uint8Array | null,
			state: RecordingState
		) => void
	): () => void {
		this.audioFrameListeners.add(handler);
		return () => this.audioFrameListeners.delete(handler);
	}

	private notifyAudioFrame(data: Uint8Array | null) {
		const state = this.getRecordingState();
		for (const handler of this.audioFrameListeners) {
			handler(data, state);
		}
	}

	private onTranscriptPreview(
		handler: (preview: string, state: RecordingState) => void
	): () => void {
		this.transcriptPreviewListeners.add(handler);
		return () => this.transcriptPreviewListeners.delete(handler);
	}

	private notifyTranscriptPreview(preview: string) {
		const state = this.getRecordingState();
		for (const handler of this.transcriptPreviewListeners) {
			handler(preview, state);
		}
	}

	private async startRecordingForBlock(opts: {
		blockId: string;
		sourcePath: string;
		mode: RecordingMode;
		onFinalText: (text: string) => void;
		onPartialText?: (text: string) => void;
		onPreviewText?: (text: string) => void;
	}): Promise<boolean> {
		if (opts.mode === "file") {
			return this.startFileRecordingForBlock(opts);
		}
		if (!this.liveTranscribe) return false;
		if (this.recordedTranscribe?.isRecording || this.recordedTranscribe?.isTranscribing) {
			new Notice("Recorded transcription is already running.");
			return false;
		}
		if (this.liveTranscribe.isRunning) {
			const active = this.streamRecordingBlockId;
			if (active && active !== opts.blockId) {
				new Notice("Another scribe block is recording.");
				return false;
			}
			if (!active) {
				new Notice("Live transcription is already running.");
				return false;
			}
		}
		this.streamRecordingBlockId = opts.blockId;
		await this.liveTranscribe.start({
			onFinalText: opts.onFinalText,
			onPartialText: opts.onPartialText,
			onPreviewText: opts.onPreviewText,
		});
		if (!this.liveTranscribe.isRunning) {
			this.streamRecordingBlockId = null;
		}
		this.notifyRecordingChange();
		return this.liveTranscribe.isRunning;
	}

	private async startFileRecordingForBlock(opts: {
		blockId: string;
		sourcePath: string;
	}): Promise<boolean> {
		if (!this.recordedTranscribe) return false;
		if (this.liveTranscribe?.isRunning) {
			new Notice("Live transcription is running. Stop it before recording audio.");
			return false;
		}
		if (this.recordedTranscribe.isRecording || this.recordedTranscribe.isTranscribing) {
			const active = this.fileRecordingBlockId;
			if (active && active !== opts.blockId) {
				new Notice("Another scribe block is recording.");
				return false;
			}
			if (!active) {
				new Notice("Recorded transcription is already running.");
				return false;
			}
		}
		this.fileRecordingBlockId = opts.blockId;
		try {
			await this.recordedTranscribe.startRecording();
			this.notifyRecordingChange();
			this.notifyAudioFrame(null);
			return this.recordedTranscribe.isRecording;
		} catch (err) {
			this.fileRecordingBlockId = null;
			this.notifyRecordingChange();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Recording failed: ${msg}`);
			return false;
		}
	}

	private stopStreamRecording() {
		this.liveTranscribe?.stop();
		this.streamRecordingBlockId = null;
		this.notifyRecordingChange();
	}

	private async stopFileRecordingForBlock(opts: {
		blockId: string;
		sourcePath: string;
		audioPath?: string;
	}): Promise<RecordedTranscriptionResult | null> {
		if (!this.recordedTranscribe?.isRecording) {
			new Notice("No recorded audio is running.");
			return null;
		}
		if (this.fileRecordingBlockId && this.fileRecordingBlockId !== opts.blockId) {
			new Notice("Another scribe block is recording.");
			return null;
		}
		try {
			const transcribePromise = this.recordedTranscribe.stopAndTranscribe({
				sourcePath: opts.sourcePath,
				existingAudioPath: opts.audioPath,
			});
			this.notifyRecordingChange();
			const result = await transcribePromise;
			this.fileRecordingBlockId = null;
			this.notifyRecordingChange();
			return result;
		} catch (err) {
			this.fileRecordingBlockId = null;
			this.notifyRecordingChange();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Recorded transcription failed: ${msg}`);
			return null;
		}
	}

	private async stopRecordingForBlock(opts: {
		blockId: string;
		sourcePath: string;
		mode: RecordingMode;
		audioPath?: string;
	}): Promise<RecordedTranscriptionResult | null> {
		if (opts.mode === "file") {
			return this.stopFileRecordingForBlock(opts);
		}
		this.stopStreamRecording();
		return null;
	}

	private async toggleWidgetRecording() {
		if (this.widgetRecordingMode === "stream") {
			if (this.recordedTranscribe?.isRecording || this.recordedTranscribe?.isTranscribing) {
				new Notice("Recorded transcription is already running.");
				return;
			}
			this.liveTranscribe?.toggle();
			return;
		}
		await this.toggleRecordedTranscription();
	}

	private async toggleRecordedTranscription() {
		if (this.recordedTranscribe?.isRecording) {
			await this.stopRecordedTranscription();
		} else {
			await this.startRecordedTranscription();
		}
	}

	private async startRecordedTranscription() {
		if (!this.recordedTranscribe) return;
		if (this.liveTranscribe?.isRunning) {
			new Notice("Live transcription is running. Stop it before recording audio.");
			return;
		}
		if (this.recordedTranscribe.isRecording) {
			new Notice("Recorded audio is already running.");
			return;
		}
		if (this.recordedTranscribe.isTranscribing) {
			new Notice("Recorded transcription is already running.");
			return;
		}
		this.recordedTranscribeSourcePath = this.app.workspace.getActiveFile()?.path ?? null;
		try {
			await this.recordedTranscribe.startRecording();
			this.notifyRecordingChange();
			new Notice("Recording audio file… run the stop command to finish.");
		} catch (err) {
			this.recordedTranscribeSourcePath = null;
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Recording failed: ${msg}`);
		}
	}

	private async stopRecordedTranscription() {
		if (!this.recordedTranscribe) return;
		if (!this.recordedTranscribe.isRecording) {
			new Notice("No recorded audio is running.");
			return;
		}
		const sourcePath = this.recordedTranscribeSourcePath ?? this.app.workspace.getActiveFile()?.path;
		this.recordedTranscribeSourcePath = null;
		try {
			const transcribePromise = this.recordedTranscribe.stopAndTranscribe({
				sourcePath: sourcePath ?? undefined,
			});
			this.notifyRecordingChange();
			const result = await transcribePromise;
			await this.insertRecordedTranscript(result);
			this.notifyRecordingChange();
			new Notice("Recorded transcription complete.");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notifyRecordingChange();
			new Notice(`Recorded transcription failed: ${msg}`);
		}
	}

	private async transcribeAudioFileFromVault() {
		if (!this.recordedTranscribe) return;
		if (this.liveTranscribe?.isRunning) {
			new Notice("Live transcription is running. Stop it before transcribing audio files.");
			return;
		}
		if (this.recordedTranscribe.isRecording || this.recordedTranscribe.isTranscribing) {
			new Notice("Recorded transcription is already running.");
			return;
		}
		const files = this.app.vault.getFiles().filter(isAudioFile);
		if (files.length === 0) {
			new Notice("No audio files found in this vault.");
			return;
		}
		const modal = new AudioFilePickerModal(this.app, {
			onChoose: (file) => {
				void this.transcribeSelectedAudioFile(file);
			},
		});
		modal.open();
	}

	private async transcribeSelectedAudioFile(file: TFile) {
		if (!this.recordedTranscribe) return;
		try {
			const transcribePromise = this.recordedTranscribe.transcribeExistingFile(file, {
				sourcePath: this.app.workspace.getActiveFile()?.path ?? undefined,
			});
			this.notifyRecordingChange();
			const result = await transcribePromise;
			await this.insertRecordedTranscript(result);
			this.notifyRecordingChange();
			new Notice(`Audio file transcribed: ${file.basename}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notifyRecordingChange();
			new Notice(`Audio transcription failed: ${msg}`);
		}
	}

	private async insertRecordedTranscript(result: RecordedTranscriptionResult) {
		const transcript = result.text.trim();
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? result.audioPath;
		const link = this.app.fileManager.generateMarkdownLink(
			result.audioFile,
			sourcePath,
			undefined,
			""
		);
		const embed = link.startsWith("!") ? link : `!${link}`;
		const parts = transcript ? [embed, transcript] : [embed];
		const payload = parts.join("\n\n");

		const editor = this.getActiveEditor();
		if (editor) {
			const cursor = editor.getCursor();
			const prefix = cursor.ch === 0 ? "" : "\n\n";
			const insertion = `${prefix}${payload}\n`;
			editor.replaceRange(insertion, cursor);
			editor.setCursor(advanceCursor(cursor, insertion));
			return;
		}

		const copied = await this.copyToClipboard(payload);
		if (copied) {
			new Notice("No active editor. Transcript copied to clipboard.");
		} else {
			new Notice("No active editor to insert transcript.");
		}
	}

	private async copyToClipboard(text: string): Promise<boolean> {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
			const area = document.createElement("textarea");
			area.value = text;
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			document.execCommand("copy");
			area.remove();
			return true;
		} catch {
			return false;
		}
	}

	private async summarizeTranscript(
		transcript: string
	): Promise<{ summary: string; model: string }> {
		if (!this.settings.openRouterApiKey?.trim()) {
			throw new Error("Missing OpenRouter API key. Set it in plugin settings.");
		}
		const system = this.getSystemPrompt("summary");
		const prompt = buildUserPrompt({
			action: "summary",
			transcription: transcript,
		});
		const out = await openRouterChatCompletion(
			{
				apiKey: this.settings.openRouterApiKey,
				model: this.settings.openRouterModel,
				referer: this.settings.openRouterReferer,
				appTitle: OPENROUTER_APP_TITLE,
			},
			{
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: prompt },
				],
				temperature: 0.4,
			}
		);
		const cleaned = stripRedundantSummaryHeading(out);
		return { summary: cleaned, model: this.settings.openRouterModel };
	}

	private async prettifyTranscript(
		transcript: string
	): Promise<{ pretty: string; model: string }> {
		if (!this.settings.openRouterApiKey?.trim()) {
			throw new Error("Missing OpenRouter API key. Set it in plugin settings.");
		}
		const system = this.getSystemPrompt("prettify");
		const prompt = buildUserPrompt({
			action: "prettify",
			transcription: transcript,
		});
		const out = await openRouterChatCompletion(
			{
				apiKey: this.settings.openRouterApiKey,
				model: this.settings.openRouterModel,
				referer: this.settings.openRouterReferer,
				appTitle: OPENROUTER_APP_TITLE,
			},
			{
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: prompt },
				],
				temperature: 0.2,
			}
		);
		return { pretty: out.trim(), model: this.settings.openRouterModel };
	}

	private getSystemPrompt(action: NotesAction) {
		if (action === "summary") {
			const custom = this.settings.summarySystemPrompt?.trim();
			return custom || buildSystemPrompt("summary");
		}
		const custom = this.settings.prettifySystemPrompt?.trim();
		return custom || buildSystemPrompt("prettify");
	}
}

function stripRedundantSummaryHeading(text: string): string {
	const lines = text.split(/\r?\n/);
	if (lines.length === 0) return text.trim();
	const first = (lines[0] ?? "").trim().toLowerCase();
	if (first === "summary" || first === "# summary" || first === "## summary") {
		// Drop the first heading and any immediate blank line.
		const rest = lines.slice(1);
		while (rest.length > 0 && rest[0]?.trim() === "") {
			rest.shift();
		}
		return rest.join("\n").trim();
	}
	return text.trim();
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

function formatTimer(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
