import { App, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "./main";
import { buildSystemPrompt, buildUserPrompt } from "./ai/voiceSummaryPrompts";

export interface MyPluginSettings {
	/** AssemblyAI API key (stored in Obsidian plugin settings). */
	assemblyAiApiKey: string;
	/** OpenRouter API key (stored in Obsidian plugin settings). */
	openRouterApiKey: string;
	/** OpenRouter model id, e.g. "openai/gpt-5-mini". */
	openRouterModel: string;
	/** Optional: sent as HTTP-Referer header to OpenRouter for attribution. */
	openRouterReferer: string;
	/** Optional: sent as X-Title header to OpenRouter for attribution. */
	openRouterAppTitle: string;
	/** Show the live widget overlay in the editor. */
	showWidget: boolean;
	/** Auto-scroll transcript while recording. */
	autoScrollTranscript: boolean;
	/** Auto-switch to transcript tab while recording. */
	autoSwitchToTranscript: boolean;
	/** AssemblyAI sample rate for streaming (Hz). */
	assemblyAiSampleRate: number;
	/** PCM16 chunk size in samples. */
	assemblyAiChunkSizeSamples: number;
	/** AssemblyAI audio encoding. */
	assemblyAiEncoding: "pcm_s16le" | "pcm_mulaw";
	/** Use formatted final turns (punctuation/casing). */
	assemblyAiFormatTurns: boolean;
	/** End-of-turn confidence threshold (0-1). */
	assemblyAiEndOfTurnConfidenceThreshold: number;
	/** Minimum silence when confident (ms). */
	assemblyAiMinEndOfTurnSilenceMs: number;
	/** Max silence before forcing turn end (ms). */
	assemblyAiMaxTurnSilenceMs: number;
	/** Custom system prompt for summary (optional). */
	summarySystemPrompt: string;
	/** Custom system prompt for prettify (optional). */
	prettifySystemPrompt: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	assemblyAiApiKey: "",
	openRouterApiKey: "",
	openRouterModel: "openai/gpt-5-mini",
	openRouterReferer: "",
	openRouterAppTitle: "Tuon Scribe",
	showWidget: false,
	autoScrollTranscript: true,
	autoSwitchToTranscript: true,
	assemblyAiSampleRate: 16000,
	assemblyAiChunkSizeSamples: 800,
	assemblyAiEncoding: "pcm_s16le",
	assemblyAiFormatTurns: true,
	assemblyAiEndOfTurnConfidenceThreshold: 0.4,
	assemblyAiMinEndOfTurnSilenceMs: 250,
	assemblyAiMaxTurnSilenceMs: 400,
	summarySystemPrompt: buildSystemPrompt("summary"),
	prettifySystemPrompt: buildSystemPrompt("prettify"),
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	private activeTab: "general" | "advanced" = "general";

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const tabs = containerEl.createDiv({ cls: "tuon-settings-tabs" });
		const generalTab = tabs.createEl("button", { text: "General", cls: "tuon-settings-tab" });
		const advancedTab = tabs.createEl("button", { text: "Advanced", cls: "tuon-settings-tab" });
		const content = containerEl.createDiv({ cls: "tuon-settings-content" });

		const render = () => {
			content.empty();
			generalTab.toggleClass("is-active", this.activeTab === "general");
			advancedTab.toggleClass("is-active", this.activeTab === "advanced");
			if (this.activeTab === "general") {
				this.renderGeneralSettings(content);
			} else {
				this.renderAdvancedSettings(content);
			}
		};

		generalTab.addEventListener("click", () => {
			this.activeTab = "general";
			render();
		});
		advancedTab.addEventListener("click", () => {
			this.activeTab = "advanced";
			render();
		});

		render();
	}

	private renderGeneralSettings(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("AssemblyAI API key")
			.setDesc("Used for live transcription. Stored locally in your Obsidian settings.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("aai-...")
					.setValue(this.plugin.settings.assemblyAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.assemblyAiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				return text;
			})
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.onClick(() => {
						void this.plugin.testAssemblyAiKey();
					})
			);

		new Setting(containerEl)
			.setName("OpenRouter API key")
			.setDesc("Used for summarization and transcript cleanup. Stored locally in your Obsidian settings.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-or-...")
					.setValue(this.plugin.settings.openRouterApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openRouterApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				return text;
			})
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.onClick(() => {
						void this.plugin.testOpenRouterKey();
					})
			);

		new Setting(containerEl)
			.setName("OpenRouter model")
			.setDesc('Example: "openai/gpt-5-mini", "anthropic/claude-3.5-sonnet", "x-ai/grok-4-fast".')
			.addText((text) =>
				text
					.setPlaceholder("openai/gpt-5-mini")
					.setValue(this.plugin.settings.openRouterModel)
					.onChange(async (value) => {
						this.plugin.settings.openRouterModel = value.trim() || DEFAULT_SETTINGS.openRouterModel;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("OpenRouter referer (optional)")
			.setDesc("If set, sent as HTTP-Referer header. Some OpenRouter features use this for attribution.")
			.addText((text) =>
				text
					.setPlaceholder("https://example.com")
					.setValue(this.plugin.settings.openRouterReferer)
					.onChange(async (value) => {
						this.plugin.settings.openRouterReferer = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show live widget in editor")
			.setDesc("Toggle the live transcription widget overlay in the editor.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showWidget)
					.onChange(async (value) => {
						this.plugin.settings.showWidget = value;
						await this.plugin.saveSettings();
						this.plugin.setWidgetVisible(value);
					})
			);
	}

	private renderAdvancedSettings(containerEl: HTMLElement) {
		containerEl.createEl("h4", { text: "Interaction" });

		new Setting(containerEl)
			.setName("Auto-scroll transcript while recording")
			.setDesc("Keep the live transcript scrolled to the bottom while recording.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoScrollTranscript)
					.onChange(async (value) => {
						this.plugin.settings.autoScrollTranscript = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-switch to transcript tab while recording")
			.setDesc("Switches to the transcript tab when recording starts.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSwitchToTranscript)
					.onChange(async (value) => {
						this.plugin.settings.autoSwitchToTranscript = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h4", { text: "AssemblyAI streaming" });

		new Setting(containerEl)
			.setName("Sample rate (Hz)")
			.setDesc("Must match the microphone audio sample rate.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.assemblyAiSampleRate))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.assemblyAiSampleRate =
							Number.isFinite(parsed) && parsed > 0
								? Math.round(parsed)
								: DEFAULT_SETTINGS.assemblyAiSampleRate;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("PCM chunk size (samples)")
			.setDesc("800 samples @ 16kHz ≈ 50ms per chunk.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.assemblyAiChunkSizeSamples))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.assemblyAiChunkSizeSamples =
							Number.isFinite(parsed) && parsed > 0
								? Math.round(parsed)
								: DEFAULT_SETTINGS.assemblyAiChunkSizeSamples;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Audio encoding")
			.setDesc("Current encoding for AssemblyAI streaming.")
			.addText((text) => {
				text
					.setValue(this.plugin.settings.assemblyAiEncoding)
					.setPlaceholder("pcm_s16le");
				text.inputEl.readOnly = true;
				return text;
			});

		new Setting(containerEl)
			.setName("Format turns")
			.setDesc("Return formatted final turns (punctuation, capitalization).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.assemblyAiFormatTurns)
					.onChange(async (value) => {
						this.plugin.settings.assemblyAiFormatTurns = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("End-of-turn confidence threshold")
			.setDesc("Higher values make turn detection stricter (0.0–1.0).")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.assemblyAiEndOfTurnConfidenceThreshold))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.assemblyAiEndOfTurnConfidenceThreshold =
							Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.assemblyAiEndOfTurnConfidenceThreshold;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Min end-of-turn silence (ms)")
			.setDesc("Minimum silence after confidence to end a turn.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.assemblyAiMinEndOfTurnSilenceMs))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.assemblyAiMinEndOfTurnSilenceMs =
							Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_SETTINGS.assemblyAiMinEndOfTurnSilenceMs;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max turn silence (ms)")
			.setDesc("Maximum silence before forcing a turn end.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.assemblyAiMaxTurnSilenceMs))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.assemblyAiMaxTurnSilenceMs =
							Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_SETTINGS.assemblyAiMaxTurnSilenceMs;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h4", { text: "Summarization prompts" });

		new Setting(containerEl)
			.setName("Summary system prompt")
			.setDesc("Editable system prompt used for summarization. Leave empty to use default.")
			.addTextArea((text) => {
				text.inputEl.rows = 6;
				text.setValue(this.plugin.settings.summarySystemPrompt || buildSystemPrompt("summary"));
				text.onChange(async (value) => {
					this.plugin.settings.summarySystemPrompt = value;
					await this.plugin.saveSettings();
				});
				return text;
			});

		new Setting(containerEl)
			.setName("Summary user prompt template")
			.setDesc("Read-only template; {{transcription}} is replaced with transcript text.")
			.addTextArea((text) => {
				text.inputEl.rows = 6;
				text.setValue(
					buildUserPrompt({
						action: "summary",
						transcription: "{{transcription}}",
						recordingStartTime: "{{recordingStartTime}}",
					})
				);
				text.inputEl.readOnly = true;
				return text;
			});

		new Setting(containerEl)
			.setName("Prettify system prompt")
			.setDesc("Editable system prompt used for prettify. Leave empty to use default.")
			.addTextArea((text) => {
				text.inputEl.rows = 6;
				text.setValue(this.plugin.settings.prettifySystemPrompt || buildSystemPrompt("prettify"));
				text.onChange(async (value) => {
					this.plugin.settings.prettifySystemPrompt = value;
					await this.plugin.saveSettings();
				});
				return text;
			});

		new Setting(containerEl)
			.setName("Prettify user prompt template")
			.setDesc("Read-only template; {{transcription}} is replaced with transcript text.")
			.addTextArea((text) => {
				text.inputEl.rows = 6;
				text.setValue(
					buildUserPrompt({
						action: "prettify",
						transcription: "{{transcription}}",
						recordingStartTime: "{{recordingStartTime}}",
					})
				);
				text.inputEl.readOnly = true;
				return text;
			});
	}
}
