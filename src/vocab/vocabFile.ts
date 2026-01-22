import { App, TFile } from "obsidian";

const VOCAB_DIR = "scribe";
const VOCAB_FILE = `${VOCAB_DIR}/VOCAB.md`;
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;
const DEFAULT_VOCAB_CONTENT = `# Vocabulary

<!-- Add one term per line. -->
`;

export const vocabPaths = {
	dir: VOCAB_DIR,
	file: VOCAB_FILE,
};

export async function ensureVocabFile(app: App): Promise<TFile> {
	const existing = app.vault.getAbstractFileByPath(VOCAB_FILE);
	if (existing instanceof TFile) {
		return existing;
	}
	if (existing) {
		throw new Error(`Vocabulary path "${VOCAB_FILE}" is not a file.`);
	}
	const folder = app.vault.getAbstractFileByPath(VOCAB_DIR);
	if (!folder) {
		await app.vault.createFolder(VOCAB_DIR);
	} else if (folder instanceof TFile) {
		throw new Error(`Vocabulary folder path "${VOCAB_DIR}" is a file.`);
	}
	return app.vault.create(VOCAB_FILE, DEFAULT_VOCAB_CONTENT);
}

export async function readVocabTerms(app: App): Promise<string[]> {
	const file = await ensureVocabFile(app);
	const content = await app.vault.read(file);
	return parseVocabTerms(content).slice(0, MAX_KEYTERMS);
}

export async function appendVocabTerm(
	app: App,
	raw: string
): Promise<{ status: "added" | "exists" | "invalid" | "too-long"; term?: string; file: TFile }> {
	const file = await ensureVocabFile(app);
	const normalized = normalizeVocabTerm(raw);
	if (!normalized) {
		return { status: "invalid", file };
	}
	if (normalized.length > MAX_KEYTERM_LENGTH) {
		return { status: "too-long", term: normalized, file };
	}
	const content = await app.vault.read(file);
	const terms = parseVocabTerms(content);
	if (terms.includes(normalized)) {
		return { status: "exists", term: normalized, file };
	}
	const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	const updated = `${content}${prefix}${normalized}\n`;
	await app.vault.modify(file, updated);
	return { status: "added", term: normalized, file };
}

export function parseVocabTerms(content: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	let inCodeFence = false;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("```")) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) continue;
		if (line.startsWith("#")) continue;
		if (line.startsWith(">")) continue;
		if (line.startsWith("<!--")) continue;

		const term = normalizeVocabTerm(line);
		if (!term) continue;
		if (term.length > MAX_KEYTERM_LENGTH) continue;
		if (seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
	}

	return terms;
}

export function normalizeVocabTerm(raw: string): string | null {
	const trimmed = raw.replace(/\s+/g, " ").trim();
	if (!trimmed) return null;
	const withoutListMarker = trimmed
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[\).\s]+/, "")
		.trim();
	const normalized = withoutListMarker.replace(/\s+/g, " ").trim();
	return normalized || null;
}
