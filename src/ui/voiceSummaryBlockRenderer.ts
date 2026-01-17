import {
	App,
	MarkdownRenderChild,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Notice,
	TFile,
	setIcon,
} from "obsidian";
import { AudioVisualizer } from "./audioVisualizer";
import {
	getTranscriptHash,
	isPrettyStale,
	isSummaryStale,
	findVoiceSummaryBlockById,
	parseVoiceSummaryBlock,
	updateVoiceSummaryBlockInFile,
	VoiceSummaryBlockData,
} from "../voiceSummary/voiceSummaryBlock";
import {
	buildRecordingStartMarker,
	buildRecordingStopMarker,
} from "../transcribe/transcriptMarkers";

type NotesAction = "summary" | "prettify";

export interface VoiceSummaryBlockActions {
	getRecordingState: () => { running: boolean; blockId: string | null };
	onRecordingChange: (handler: (state: { running: boolean; blockId: string | null }) => void) => () => void;
	onTranscriptPreview: (
		handler: (preview: string, state: { running: boolean; blockId: string | null }) => void
	) => () => void;
	onAudioFrame: (
		handler: (data: Uint8Array | null, state: { running: boolean; blockId: string | null }) => void
	) => () => void;
	getInteractionSettings: () => { autoScrollTranscript: boolean; autoSwitchToTranscript: boolean };
	getTimestampSettings: () => { scribeBlockTimestamps: boolean };
	startRecordingForBlock: (opts: {
		blockId: string;
		sourcePath: string;
		onFinalText: (text: string) => void;
		onPartialText?: (text: string) => void;
		onPreviewText?: (text: string) => void;
	}) => Promise<boolean>;
	stopRecording: () => void;
	summarizeTranscript: (transcript: string) => Promise<{ summary: string; model: string }>;
	prettifyTranscript: (transcript: string) => Promise<{ pretty: string; model: string }>;
}

export function renderVoiceSummaryBlock(opts: {
	app: App;
	el: HTMLElement;
	source: string;
	sourcePath: string;
	component: MarkdownRenderChild;
	actions: VoiceSummaryBlockActions;
}) {
	const parsed = parseVoiceSummaryBlock(opts.source);
	opts.el.empty();

	if (!parsed.data) {
		const error = opts.el.createDiv({ cls: "tuon-voice-block tuon-voice-error" });
		error.createEl("strong", { text: "Scribe block error" });
		error.createDiv({ text: parsed.error || "Unable to parse scribe block." });
		const raw = error.createEl("pre");
		raw.textContent = opts.source;
		return;
	}

	let data = parsed.data;
	const initialRecordingState = opts.actions.getRecordingState();
	const initialInteraction = opts.actions.getInteractionSettings();
	const shouldForceTranscript =
		initialInteraction.autoSwitchToTranscript &&
		initialRecordingState.running &&
		initialRecordingState.blockId === data.id;
	let activeTab: "transcript" | "summary" | "pretty" = shouldForceTranscript
		? "transcript"
		: data.summary
		? "summary"
		: data.pretty
		? "pretty"
		: "transcript";
	let draftTranscript = data.transcript;
	let livePreview = "";
	let isDirty = false;
	let isProcessing = false;
	let notesAction: NotesAction = "summary";
	let recordingStartedAt: Date | null = null;
	let recordingWasActive = false;
	let clearConfirm = false;
	let clearAnimating = false;
	let copySuccess = false;
	let copyTimer: number | null = null;
	let isEditingTitle = false;
	let titleBlurMode: "save" | "cancel" | null = null;

	const container = opts.el.createDiv({ cls: "tuon-voice-block" });
	const header = container.createDiv({ cls: "tuon-voice-block__header" });
	const headerRow1 = header.createDiv({ cls: "tuon-voice-block__header-row" });
	const titleWrap = headerRow1.createDiv({ cls: "tuon-voice-block__title-wrap" });
	const titleDisplay = titleWrap.createDiv({
		cls: "tuon-voice-block__title",
		text: data.title || "Scribe",
	});
	const titleEdit = titleWrap.createDiv({ cls: "tuon-voice-block__title-edit" });
	const titleInput = titleEdit.createEl("input", {
		cls: "tuon-voice-block__title-input",
		type: "text",
	});
	const titleCancel = titleEdit.createEl("button", {
		cls: "tuon-voice-block__title-button",
	});
	const titleSave = titleEdit.createEl("button", {
		cls: "tuon-voice-block__title-button mod-cta",
	});
	const headerRow2 = header.createDiv({ cls: "tuon-voice-block__header-row" });
	const visualizerWrap = headerRow2.createDiv({ cls: "tuon-voice-block__visualizer-wrap" });
	const visualizerCanvas = visualizerWrap.createEl("canvas", {
		cls: "tuon-voice-block__visualizer",
	});
	visualizerCanvas.width = 145;
	visualizerCanvas.height = 24;
	const visualizerPreview = visualizerWrap.createDiv({
		cls: "tuon-voice-block__visualizer-preview",
		text: "",
	});
	const actionsWrap = headerRow2.createDiv({ cls: "tuon-voice-block__actions" });
	const recordButton = actionsWrap.createEl("button", {
		cls: "tuon-voice-record-button",
	});
	const recordIcon = recordButton.createSpan({ cls: "tuon-voice-record-button__icon" });
	const actionGroup = actionsWrap.createDiv({ cls: "tuon-voice-button-group" });
	const summarizeButton = actionGroup.createEl("button", {
		cls: "tuon-voice-button mod-cta",
	});
	const summarizeSpinner = summarizeButton.createSpan({ cls: "tuon-voice-spinner" });
	const summarizeIcon = summarizeButton.createSpan({ cls: "tuon-voice-button__icon" });
	const summarizeLabel = summarizeButton.createSpan({
		cls: "tuon-voice-button__label",
		text: "Summarize",
	});
	const summarizeDropdownButton = actionGroup.createEl("button", {
		cls: "tuon-voice-button mod-cta tuon-voice-button--split",
	});
	const summarizeDropdownIcon = summarizeDropdownButton.createSpan({
		cls: "tuon-voice-button__icon",
	});
	const menuButton = actionsWrap.createEl("button", {
		cls: "tuon-voice-menu-button",
	});
	const menuIcon = menuButton.createSpan({ cls: "tuon-voice-menu-button__icon" });
	const tabsRow = container.createDiv({ cls: "tuon-voice-block__tabs-row" });
	const tabs = tabsRow.createDiv({ cls: "tuon-voice-block__tabs" });
	const transcriptTab = tabs.createEl("button", { text: "Transcript" });
	const summaryTab = tabs.createEl("button", { text: "Summary" });
	const prettyTab = tabs.createEl("button", { text: "Pretty" });
	const tabsActions = tabsRow.createDiv({ cls: "tuon-voice-block__tabs-actions" });
	const clearButton = tabsActions.createEl("button", {
		cls: "tuon-voice-clear-button",
	});
	const clearIcon = clearButton.createSpan({ cls: "tuon-voice-clear-button__icon" });
	const copyButton = tabsActions.createEl("button", {
		cls: "tuon-voice-copy-button",
	});
	const copyIcon = copyButton.createSpan({ cls: "tuon-voice-copy-button__icon" });
	const panels = container.createDiv({ cls: "tuon-voice-block__panels" });
	const transcriptPanel = panels.createDiv({ cls: "tuon-voice-block__panel" });
	const summaryPanel = panels.createDiv({ cls: "tuon-voice-block__panel" });
	const prettyPanel = panels.createDiv({ cls: "tuon-voice-block__panel" });

	const transcriptTextarea = transcriptPanel.createEl("textarea", {
		cls: "tuon-voice-block__textarea",
	});
	const transcriptReadonly = transcriptPanel.createDiv({
		cls: "tuon-voice-block__readonly markdown-rendered",
	});
	const transcriptHint = transcriptPanel.createDiv({
		cls: "tuon-voice-block__hint",
		text: "",
	});

	const summaryContent = summaryPanel.createDiv({
		cls: "tuon-voice-block__summary markdown-rendered",
	});
	const summaryHint = summaryPanel.createDiv({ cls: "tuon-voice-block__hint" });
	const summaryMeta = summaryPanel.createDiv({ cls: "tuon-voice-block__meta" });

	const prettyContent = prettyPanel.createDiv({
		cls: "tuon-voice-block__summary markdown-rendered",
	});
	const prettyHint = prettyPanel.createDiv({ cls: "tuon-voice-block__hint" });
	const prettyMeta = prettyPanel.createDiv({ cls: "tuon-voice-block__meta" });

	function getRecordingState() {
		return opts.actions.getRecordingState();
	}

	const visualizer = new AudioVisualizer({
		canvas: visualizerCanvas,
		barWidth: 3,
		barGap: 1,
		sensitivity: 6,
	});

	function renderMarkdown(target: HTMLElement, markdown: string) {
		target.empty();
		MarkdownRenderer.renderMarkdown(markdown, target, opts.sourcePath, opts.component);
	}

	function scrollTranscriptReadonlyToBottom() {
		if (transcriptReadonly.style.display === "none") return;
		requestAnimationFrame(() => {
			transcriptReadonly.scrollTop = transcriptReadonly.scrollHeight;
		});
	}

	function updateTitleView() {
		titleDisplay.textContent = (data.title || "Scribe").trim() || "Scribe";
		titleDisplay.toggleClass("is-editing", isEditingTitle);
		titleEdit.style.display = isEditingTitle ? "flex" : "none";
		titleDisplay.style.display = isEditingTitle ? "none" : "block";
	}

	async function commitTitle(nextTitle: string) {
		const normalized = nextTitle.trim() || "Scribe";
		const updated = await updateVoiceSummaryBlockInFile(
			opts.app,
			opts.sourcePath,
			data.id,
			(current) => ({
				...current,
				title: normalized,
				updatedAt: new Date().toISOString(),
			})
		);
		if (updated) {
			data = updated;
		} else {
			data.title = normalized;
		}
		isEditingTitle = false;
		updateTitleView();
	}

	function cancelTitleEdit() {
		isEditingTitle = false;
		updateTitleView();
	}

	function beginTitleEdit() {
		if (isEditingTitle) return;
		isEditingTitle = true;
		titleInput.value = (data.title || "Scribe").trim() || "Scribe";
		titleBlurMode = null;
		updateTitleView();
		titleInput.focus();
		titleInput.select();
	}

	function resizeTranscriptTextarea() {
		if (transcriptTextarea.style.display === "none") return;
		if (transcriptPanel.style.display === "none") return;
		transcriptTextarea.style.height = "auto";
		const maxHeight = 600;
		const minHeight = 140;
		const scrollHeight = transcriptTextarea.scrollHeight;
		const next = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
		transcriptTextarea.style.height = `${next}px`;
		transcriptTextarea.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
	}

	function scheduleResizeTranscriptTextarea() {
		if (transcriptTextarea.style.display === "none") return;
		if (transcriptPanel.style.display === "none") return;
		requestAnimationFrame(() => {
			resizeTranscriptTextarea();
		});
	}

	function isThisBlockRecording(state: { running: boolean; blockId: string | null }) {
		return state.running && state.blockId === data.id;
	}

	function updateTabs() {
		transcriptTab.toggleClass("is-active", activeTab === "transcript");
		summaryTab.toggleClass("is-active", activeTab === "summary");
		prettyTab.toggleClass("is-active", activeTab === "pretty");
		transcriptPanel.style.display = activeTab === "transcript" ? "block" : "none";
		summaryPanel.style.display = activeTab === "summary" ? "block" : "none";
		prettyPanel.style.display = activeTab === "pretty" ? "block" : "none";
	}

	function updateSummaryView() {
		const summaryText = (data.summary || "").trim();
		const stale = isSummaryStale(data);
		if (!summaryText) {
			summaryContent.textContent = "";
			summaryHint.textContent = "No summary yet. Click Summarize to generate one.";
		} else {
			renderMarkdown(summaryContent, summaryText);
			summaryHint.textContent = stale
				? "Summary is out of date. Click Summarize to regenerate."
				: "Summary is up to date.";
		}
		const meta = data.summaryMeta?.updatedAt
			? `Last updated ${data.summaryMeta.updatedAt}`
			: "";
		summaryMeta.textContent = meta;
	}

	function updatePrettyView() {
		const prettyText = (data.pretty || "").trim();
		const stale = isPrettyStale(data);
		if (!prettyText) {
			prettyContent.textContent = "";
			prettyHint.textContent = "No prettified text yet. Click Prettify to generate one.";
		} else {
			renderMarkdown(prettyContent, prettyText);
			prettyHint.textContent = stale
				? "Prettified text is out of date. Click Prettify to regenerate."
				: "Prettified text is up to date.";
		}
		const meta = data.prettyMeta?.updatedAt
			? `Last updated ${data.prettyMeta.updatedAt}`
			: "";
		prettyMeta.textContent = meta;
	}

	function getLastWords(text: string, count = 4) {
		const words = text.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return "";
		return words.slice(-count).join(" ");
	}

	function updateVisualizerPreview() {
		const source = livePreview.trim() || (data.transcript || "").trim();
		visualizerPreview.textContent = source ? getLastWords(source, 5) : "";
	}

	function updateTranscriptView() {
		const recordingState = getRecordingState();
		const recording = isThisBlockRecording(recordingState);
		transcriptHint.textContent = recording ? "Transcript editing is locked while recording." : "";
		transcriptHint.style.display = recording ? "block" : "none";
		transcriptReadonly.style.display = recording ? "block" : "none";
		transcriptTextarea.style.display = recording ? "none" : "block";
		if (data.transcript?.trim()) {
			renderMarkdown(transcriptReadonly, data.transcript);
			const interaction = opts.actions.getInteractionSettings();
			if (recording && interaction.autoScrollTranscript) {
				scrollTranscriptReadonlyToBottom();
			}
		} else {
			transcriptReadonly.textContent = "No transcript yet.";
		}
		if (!isDirty && !recording) {
			transcriptTextarea.value = data.transcript || "";
			draftTranscript = data.transcript || "";
		}
		if (!recording) {
			scheduleResizeTranscriptTextarea();
		}
		updateVisualizerPreview();
	}

	function getActiveActionLabel(action: NotesAction) {
		return action === "summary" ? "Summarize" : "Prettify";
	}

	function getActiveActionStale(action: NotesAction) {
		return action === "summary" ? isSummaryStale(data) : isPrettyStale(data);
	}

	function updatePrimaryActionView() {
		const actionLabel = getActiveActionLabel(notesAction);
		const stale = getActiveActionStale(notesAction);
		const iconName =
			notesAction === "summary"
				? stale
					? "triangle-alert"
					: "notepad-text"
				: stale
				? "triangle-alert"
				: "wand-sparkles";
		const title =
			notesAction === "summary"
				? stale
					? "Summary out of date"
					: "Summarize"
				: stale
				? "Prettified text out of date"
				: "Prettify";

		summarizeLabel.textContent = actionLabel;
		summarizeButton.setAttr("title", title);
		setIcon(summarizeIcon, iconName);
	}

	function updateActionState() {
		const recordingState = getRecordingState();
		const recording = isThisBlockRecording(recordingState);
		const transcriptHasText = (data.transcript || "").trim().length > 0;
		const isOtherRecording = recordingState.running && recordingState.blockId !== data.id;
		clearButton.disabled = recording || isProcessing;
		clearButton.setAttr("aria-label", clearConfirm ? "Confirm clear" : "Clear transcript");
		clearButton.setAttr("title", clearConfirm ? "Confirm clear" : "Clear transcript");
		clearButton.toggleClass("is-confirm", clearConfirm);
		clearButton.toggleClass("is-shredding", clearAnimating);
		if (clearAnimating) {
			setIcon(clearIcon, "shredder");
		} else if (clearConfirm) {
			setIcon(clearIcon, "x");
		} else {
			setIcon(clearIcon, "eraser");
		}

		const activeText = getActiveTabText().text;
		copyButton.disabled = isProcessing || !activeText;
		copyButton.setAttr("aria-label", "Copy active tab");
		copyButton.setAttr("title", "Copy active tab");
		copyButton.toggleClass("is-success", copySuccess);
		setIcon(copyIcon, copySuccess ? "check" : "copy");

		recordButton.setAttr("aria-label", recording ? "Stop recording" : "Start recording");
		recordButton.setAttr("title", recording ? "Stop recording" : "Start recording");
		recordButton.textContent = "";
		recordButton.appendChild(recordIcon);
		setIcon(recordIcon, recording ? "square" : "mic");
		recordButton.toggleClass("is-recording", recording);
		recordButton.disabled = isOtherRecording;
		summarizeButton.disabled = !transcriptHasText || recording || isProcessing;
		summarizeDropdownButton.disabled = summarizeButton.disabled;
		if (isProcessing) {
			summarizeLabel.textContent =
				notesAction === "summary" ? "Summarizing…" : "Prettifying…";
			summarizeSpinner.style.display = "inline-flex";
			summarizeIcon.style.display = "none";
		} else {
			summarizeSpinner.style.display = "none";
			summarizeIcon.style.display = "inline-flex";
			updatePrimaryActionView();
		}
	}

	function getActiveTabText(): { label: string; text: string } {
		if (activeTab === "summary") {
			return { label: "Summary", text: (data.summary || "").trim() };
		}
		if (activeTab === "pretty") {
			return { label: "Pretty", text: (data.pretty || "").trim() };
		}
		const transcriptText = (isDirty ? draftTranscript : data.transcript || "").trim();
		return { label: "Transcript", text: transcriptText };
	}

	async function handleCopyActiveTab() {
		const { label, text } = getActiveTabText();
		if (!text) {
			new Notice(`No ${label.toLowerCase()} text to copy.`);
			return;
		}
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				const area = document.createElement("textarea");
				area.value = text;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				document.execCommand("copy");
				area.remove();
			}
			copySuccess = true;
			updateActionState();
			if (copyTimer) window.clearTimeout(copyTimer);
			copyTimer = window.setTimeout(() => {
				copySuccess = false;
				updateActionState();
			}, 900);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Copy failed: ${msg}`);
		}
	}

	async function applyTranscriptUpdate(nextTranscript: string) {
		const updated = await updateVoiceSummaryBlockInFile(
			opts.app,
			opts.sourcePath,
			data.id,
			(current) => ({
				...current,
				transcript: nextTranscript,
				updatedAt: new Date().toISOString(),
			})
		);
		if (updated) {
			data = updated;
			isDirty = false;
			updateTranscriptView();
			updateSummaryView();
			updatePrettyView();
			updateActionState();
		}
	}

	async function clearTranscriptAndOutputs() {
		const updated = await updateVoiceSummaryBlockInFile(
			opts.app,
			opts.sourcePath,
			data.id,
			(current) => ({
				...current,
				transcript: "",
				summary: "",
				pretty: "",
				updatedAt: new Date().toISOString(),
				summaryMeta: {
					transcriptHashAtSummary: "",
					model: "",
					updatedAt: "",
				},
				prettyMeta: {
					transcriptHashAtPrettify: "",
					model: "",
					updatedAt: "",
				},
			})
		);
		if (updated) {
			data = updated;
			isDirty = false;
			draftTranscript = "";
			updateTranscriptView();
			updateSummaryView();
			updatePrettyView();
			updateActionState();
		}
	}

	async function findBlockMatch() {
		const file = opts.app.vault.getAbstractFileByPath(opts.sourcePath);
		if (!(file instanceof TFile)) return null;
		const content = await opts.app.vault.read(file);
		return findVoiceSummaryBlockById(content, data.id);
	}

	async function focusBlockInEditor() {
		const file = opts.app.vault.getAbstractFileByPath(opts.sourcePath);
		if (!(file instanceof TFile)) return;
		const leaf = opts.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const view = opts.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const match = await findBlockMatch();
		if (!match) return;
		const editor = view.editor;
		const start = editor.offsetToPos(match.start);
		const end = editor.offsetToPos(match.end);
		editor.setSelection(start, end);
		editor.scrollIntoView({ from: start, to: end }, true);
	}

	async function deleteBlock() {
		const file = opts.app.vault.getAbstractFileByPath(opts.sourcePath);
		if (!(file instanceof TFile)) return;
		const content = await opts.app.vault.read(file);
		const match = findVoiceSummaryBlockById(content, data.id);
		if (!match) return;
		const next = content.slice(0, match.start) + content.slice(match.end);
		await opts.app.vault.modify(file, next);
	}

	async function appendTranscriptMarker(text: string) {
		const trimmed = text.trim();
		if (!trimmed) return;
		const updated = await updateVoiceSummaryBlockInFile(
			opts.app,
			opts.sourcePath,
			data.id,
			(current) => {
				const base = current.transcript || "";
				const prefix = base.trim().length ? "\n\n" : "";
				return {
					...current,
					transcript: `${base}${prefix}${trimmed}\n\n`,
					updatedAt: new Date().toISOString(),
				};
			}
		);
		if (updated) {
			data = updated;
			updateTranscriptView();
			updateSummaryView();
			updatePrettyView();
			updateActionState();
		}
	}

	async function appendTranscript(text: string) {
		const trimmed = text.trim();
		if (!trimmed) return;
		const updated = await updateVoiceSummaryBlockInFile(
			opts.app,
			opts.sourcePath,
			data.id,
			(current) => {
				const base = current.transcript || "";
				const spacer = base && !/\s$/.test(base) ? " " : "";
				return {
					...current,
					transcript: `${base}${spacer}${trimmed}`,
					updatedAt: new Date().toISOString(),
				};
			}
		);
		if (updated) {
			data = updated;
			updateTranscriptView();
			updateSummaryView();
			updatePrettyView();
			updateActionState();
		}
	}

	clearButton.addEventListener("click", async () => {
		if (clearButton.disabled) return;
		if (!clearConfirm) {
			clearConfirm = true;
			updateActionState();
			return;
		}
		clearConfirm = false;
		clearAnimating = true;
		updateActionState();
		await clearTranscriptAndOutputs();
		window.setTimeout(() => {
			clearAnimating = false;
			updateActionState();
		}, 400);
	});

	copyButton.addEventListener("click", async () => {
		if (copyButton.disabled) return;
		await handleCopyActiveTab();
	});

	titleDisplay.addEventListener("click", () => {
		beginTitleEdit();
	});

	titleInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void commitTitle(titleInput.value);
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancelTitleEdit();
		}
	});

	titleInput.addEventListener("blur", () => {
		const mode = titleBlurMode;
		titleBlurMode = null;
		if (mode === "cancel") {
			cancelTitleEdit();
			return;
		}
		void commitTitle(titleInput.value);
	});

	titleCancel.addEventListener("pointerdown", () => {
		titleBlurMode = "cancel";
	});

	titleSave.addEventListener("pointerdown", () => {
		titleBlurMode = "save";
	});

	titleCancel.addEventListener("click", (event) => {
		event.preventDefault();
		cancelTitleEdit();
	});

	titleSave.addEventListener("click", (event) => {
		event.preventDefault();
		void commitTitle(titleInput.value);
	});

	menuButton.addEventListener("click", (event) => {
		event.preventDefault();
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Edit block").setIcon("pencil").onClick(() => {
				void focusBlockInEditor();
			})
		);
		menu.addItem((item) =>
			item.setTitle("Delete block").setIcon("trash-2").onClick(() => {
				const ok = window.confirm("Delete this scribe block?");
				if (ok) {
					void deleteBlock();
				}
			})
		);
		menu.showAtMouseEvent(event);
	});

	recordButton.addEventListener("click", async () => {
		const recordingState = getRecordingState();
		if (isThisBlockRecording(recordingState)) {
			opts.actions.stopRecording();
			return;
		}
		if (isDirty) {
			await applyTranscriptUpdate(draftTranscript);
		}
		const ok = await opts.actions.startRecordingForBlock({
			blockId: data.id,
			sourcePath: opts.sourcePath,
			onFinalText: (text) => void appendTranscript(text),
		});
		if (!ok) {
			new Notice("Unable to start recording for this block.");
			return;
		}
		recordingStartedAt = new Date();
		recordingWasActive = true;
		if (opts.actions.getTimestampSettings().scribeBlockTimestamps) {
			await appendTranscriptMarker(buildRecordingStartMarker(recordingStartedAt));
		}
	});

	transcriptTab.addEventListener("click", () => {
		activeTab = "transcript";
		updateTabs();
		scheduleResizeTranscriptTextarea();
	});
	summaryTab.addEventListener("click", () => {
		activeTab = "summary";
		updateTabs();
	});
	prettyTab.addEventListener("click", () => {
		activeTab = "pretty";
		updateTabs();
	});

	transcriptTextarea.addEventListener("input", () => {
		draftTranscript = transcriptTextarea.value;
		isDirty = draftTranscript !== data.transcript;
		resizeTranscriptTextarea();
		updateActionState();
	});

	transcriptTextarea.addEventListener("blur", () => {
		if (isDirty) {
			void applyTranscriptUpdate(draftTranscript);
		}
	});

	async function runNotesAction(action: NotesAction) {
		const transcript = (isDirty ? draftTranscript : data.transcript || "").trim();
		if (!transcript) {
			new Notice(action === "summary" ? "No transcript to summarize." : "No transcript to prettify.");
			return;
		}
		if (isDirty) {
			await applyTranscriptUpdate(draftTranscript);
		}
		isProcessing = true;
		updateActionState();
		try {
			const hash = getTranscriptHash(transcript);
			const now = new Date().toISOString();
			if (action === "summary") {
				const result = await opts.actions.summarizeTranscript(transcript);
				const updated = await updateVoiceSummaryBlockInFile(
					opts.app,
					opts.sourcePath,
					data.id,
					(current) => ({
						...current,
						summary: result.summary,
						updatedAt: now,
						summaryMeta: {
							transcriptHashAtSummary: hash,
							model: result.model,
							updatedAt: now,
						},
					})
				);
				if (updated) {
					data = updated;
				}
				activeTab = "summary";
			} else {
				const result = await opts.actions.prettifyTranscript(transcript);
				const updated = await updateVoiceSummaryBlockInFile(
					opts.app,
					opts.sourcePath,
					data.id,
					(current) => ({
						...current,
						pretty: result.pretty,
						updatedAt: now,
						prettyMeta: {
							transcriptHashAtPrettify: hash,
							model: result.model,
							updatedAt: now,
						},
					})
				);
				if (updated) {
					data = updated;
				}
				activeTab = "pretty";
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const label = action === "summary" ? "Summarize" : "Prettify";
			new Notice(`${label} failed: ${msg}`);
		} finally {
			isProcessing = false;
			updateTabs();
			updateSummaryView();
			updatePrettyView();
			updateActionState();
		}
	}

	summarizeButton.addEventListener("click", async () => {
		await runNotesAction(notesAction);
	});

	summarizeDropdownButton.addEventListener("click", (event) => {
		event.preventDefault();
		if (summarizeDropdownButton.disabled) return;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Summarize")
				.setIcon("notepad-text")
				.onClick(() => {
					notesAction = "summary";
					updateActionState();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Prettify")
				.setIcon("wand-sparkles")
				.onClick(() => {
					notesAction = "prettify";
					updateActionState();
				})
		);
		menu.showAtMouseEvent(event);
	});

	const onDocumentPointerDown = (event: PointerEvent) => {
		if (!clearConfirm) return;
		const target = event.target as Node | null;
		if (target && clearButton.contains(target)) return;
		clearConfirm = false;
		updateActionState();
	};
	document.addEventListener("pointerdown", onDocumentPointerDown, true);

	const unsubscribe = opts.actions.onRecordingChange((state) => {
		const recording = isThisBlockRecording(state);
		const interaction = opts.actions.getInteractionSettings();
		if (!recording && livePreview) {
			livePreview = "";
			updateVisualizerPreview();
		}
		if (recording && interaction.autoSwitchToTranscript && activeTab !== "transcript") {
			activeTab = "transcript";
			updateTabs();
		}
		if (!recording && recordingWasActive) {
			const stoppedAt = new Date();
			if (opts.actions.getTimestampSettings().scribeBlockTimestamps) {
				void appendTranscriptMarker(buildRecordingStopMarker(stoppedAt, recordingStartedAt));
			}
			recordingStartedAt = null;
			recordingWasActive = false;
		}
		visualizer.update(null, state.running && state.blockId === data.id);
		updateTranscriptView();
		updateActionState();
	});

	const unsubscribePreview = opts.actions.onTranscriptPreview((preview, state) => {
		if (state.running && state.blockId === data.id) {
			livePreview = preview || "";
			updateVisualizerPreview();
			return;
		}
		if (livePreview) {
			livePreview = "";
			updateVisualizerPreview();
		}
	});

	const unsubscribeAudio = opts.actions.onAudioFrame((frame, state) => {
		const isActive = state.running && state.blockId === data.id;
		if (!isActive || !frame) return;
		visualizer.update(frame, true);
	});

	setIcon(summarizeIcon, "notepad-text");
	setIcon(summarizeDropdownIcon, "chevron-down");
	setIcon(clearIcon, "eraser");
	setIcon(copyIcon, "copy");
	setIcon(menuIcon, "more-vertical");
	setIcon(titleCancel, "x");
	setIcon(titleSave, "check");

	updateTabs();
	updateTranscriptView();
	updateSummaryView();
	updatePrettyView();
	updateActionState();
	updateTitleView();
	const initialState = getRecordingState();
	visualizer.update(null, initialState.running && initialState.blockId === data.id);

	return () => {
		unsubscribe?.();
		unsubscribePreview?.();
		unsubscribeAudio?.();
		document.removeEventListener("pointerdown", onDocumentPointerDown, true);
		if (copyTimer) {
			window.clearTimeout(copyTimer);
			copyTimer = null;
		}
	};
}
