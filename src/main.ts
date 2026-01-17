import {
	App,
	Editor,
	MarkdownRenderChild,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	TFile,
	setIcon,
} from "obsidian";
import { DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab } from "./settings";
import { openRouterChatCompletion } from "./ai/openrouter";
import { buildSystemPrompt, buildUserPrompt, NotesAction } from "./ai/voiceSummaryPrompts";
import { LiveTranscribeService } from "./transcribe/liveTranscribeService";
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
} from "./voiceSummary/voiceSummaryBlock";
import { renderVoiceSummaryBlock } from "./ui/voiceSummaryBlockRenderer";
import {
	showTestResultToast,
	testAssemblyAiApiKey,
	testOpenRouterApiKey,
} from "./diagnostics/apiKeyDiagnostics";

const OPENROUTER_APP_TITLE = "Tuon Scribe";

// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	private liveTranscribe: LiveTranscribeService | null = null;
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
	private audioVisualizer: AudioVisualizer | null = null;
	private readonly widgetMinWidth = 220;
	private readonly widgetMaxWidth = 390;
	private recordingBlockId: string | null = null;
	private recordingListeners = new Set<
		(state: { running: boolean; blockId: string | null }) => void
	>();
	private transcriptPreviewListeners = new Set<
		(preview: string, state: { running: boolean; blockId: string | null }) => void
	>();
	private audioFrameListeners = new Set<
		(data: Uint8Array | null, state: { running: boolean; blockId: string | null }) => void
	>();

	async onload() {
		await this.loadSettings();

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
			onStatusText: (t) => this.updateStatusText(t),
			onRunningChange: (running) => {
				const wasBlockRecording = Boolean(this.recordingBlockId);
				this.updateWidgetState(running);
				if (running) {
					if (!wasBlockRecording) {
						this.handleEditorRecordingStart();
					}
				} else {
					if (!wasBlockRecording) {
						this.handleEditorRecordingStop();
					}
					this.recordingBlockId = null;
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
			id: "tuon-summarize-selection",
			name: "Tuon: Summarize selection (OpenRouter)",
			editorCallback: async (editor: Editor) => {
				await this.runNotesAction(editor, "summary");
			},
		});

		this.addCommand({
			id: "tuon-prettify-selection",
			name: "Tuon: Prettify selection (OpenRouter)",
			editorCallback: async (editor: Editor) => {
				await this.runNotesAction(editor, "prettify");
			},
		});

		this.addCommand({
			id: "tuon-insert-voice-summary-block",
			name: "Tuon: Insert scribe block",
			editorCallback: (editor: Editor) => {
				this.insertVoiceSummaryBlock(editor);
			},
		});

		this.addCommand({
			id: "tuon-test-assemblyai-key",
			name: "Tuon: Test AssemblyAI API key",
			callback: () => void this.testAssemblyAiKey(),
		});

		this.addCommand({
			id: "tuon-test-openrouter-key",
			name: "Tuon: Test OpenRouter API key",
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
						stopRecording: () => this.stopRecording(),
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
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {
		try {
			this.liveTranscribe?.stop();
		} catch {}
		this.statusBarItemEl?.setText("");
		this.destroyLiveWidget();
		this.widgetRibbonEl?.remove();
		this.widgetRibbonEl = null;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private updateStatusText(text: string) {
		const preview = (text || "").trim();
		this.notifyTranscriptPreview(preview);
		if (this.recordingBlockId) return;
		if (this.widgetTranscriptEl) {
			this.widgetTranscriptEl.textContent = preview || "Say something to begin…";
			this.scrollWidgetTranscriptToBottom();
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

	private updateWidgetState(running: boolean) {
		const widgetRunning = running && !this.recordingBlockId;
		this.widgetRunning = widgetRunning;
		if (this.widgetButtonEl) {
			this.updateWidgetButtonIcon(widgetRunning);
			this.widgetButtonEl.style.background = widgetRunning
				? "var(--color-red)"
				: "var(--background-secondary)";
			this.widgetButtonEl.style.color = widgetRunning ? "white" : "var(--text-normal)";
		}
		this.statusBarItemEl?.setText(running ? "Listening…" : "");
		if (this.widgetEl) {
			this.widgetEl.dataset.running = widgetRunning ? "true" : "false";
		}
		if (widgetRunning) {
			this.startWidgetTimer();
		} else {
			this.stopWidgetTimer();
			this.audioVisualizer?.update(null, false);
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
			if (this.recordingBlockId) {
				new Notice("Recording is active in a scribe block.");
				return;
			}
			this.liveTranscribe?.toggle();
		});

		header.appendChild(visualizerWrap);
		header.appendChild(button);

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

	private updateWidgetOffset() {
		if (!this.widgetEl) return;
		const statusBar = document.querySelector(".status-bar") as HTMLElement | null;
		const statusBarHeight = statusBar?.getBoundingClientRect().height ?? 0;
		const gutter = 8;
		const minBottom = 16;
		const bottom = Math.max(minBottom, Math.ceil(statusBarHeight + gutter));
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

	private updateVisualizer(data: Uint8Array) {
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
		const fence = buildVoiceSummaryFence(data);
		const cursor = editor.getCursor();
		editor.replaceRange(`${fence}\n\n`, cursor);
	}

	private getRecordingState(): { running: boolean; blockId: string | null } {
		return {
			running: this.liveTranscribe?.isRunning ?? false,
			blockId: this.recordingBlockId,
		};
	}

	private onRecordingChange(
		handler: (state: { running: boolean; blockId: string | null }) => void
	): () => void {
		this.recordingListeners.add(handler);
		return () => this.recordingListeners.delete(handler);
	}

	private notifyRecordingChange() {
		const state = this.getRecordingState();
		for (const handler of this.recordingListeners) {
			handler(state);
		}
	}

	private onAudioFrame(
		handler: (
			data: Uint8Array | null,
			state: { running: boolean; blockId: string | null }
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
		handler: (preview: string, state: { running: boolean; blockId: string | null }) => void
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
		onFinalText: (text: string) => void;
		onPartialText?: (text: string) => void;
		onPreviewText?: (text: string) => void;
	}): Promise<boolean> {
		if (!this.liveTranscribe) return false;
		if (this.liveTranscribe.isRunning) {
			const active = this.recordingBlockId;
			if (active && active !== opts.blockId) {
				new Notice("Another scribe block is recording.");
				return false;
			}
			if (!active) {
				new Notice("Live transcription is already running.");
				return false;
			}
		}
		this.recordingBlockId = opts.blockId;
		await this.liveTranscribe.start({
			onFinalText: opts.onFinalText,
			onPartialText: opts.onPartialText,
			onPreviewText: opts.onPreviewText,
		});
		if (!this.liveTranscribe.isRunning) {
			this.recordingBlockId = null;
		}
		this.notifyRecordingChange();
		return this.liveTranscribe.isRunning;
	}

	private stopRecording() {
		this.liveTranscribe?.stop();
		this.recordingBlockId = null;
		this.notifyRecordingChange();
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

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
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

function formatTimer(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
