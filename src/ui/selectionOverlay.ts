import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

type OverlayState = { from: number; to: number; label: string } | null;
type OverlayValue = { overlay: OverlayState; decorations: DecorationSet };

const showOverlay = StateEffect.define<{ from: number; to: number; label: string }>();
const hideOverlay = StateEffect.define<void>();

const overlayField = StateField.define<OverlayValue>({
	create() {
		return { overlay: null, decorations: Decoration.none };
	},
	update(value, tr) {
		let overlay = value.overlay;
		let decorations = value.decorations;
		for (const effect of tr.effects) {
			if (effect.is(showOverlay)) {
				const from = Math.min(effect.value.from, effect.value.to);
				const to = Math.max(effect.value.from, effect.value.to);
				overlay = { from, to, label: effect.value.label };
			} else if (effect.is(hideOverlay)) {
				overlay = null;
			}
		}
		if (overlay) {
			const from = tr.changes.mapPos(overlay.from, 1);
			const to = tr.changes.mapPos(overlay.to, -1);
			const hasRange = from !== to;
			decorations = hasRange
				? Decoration.set([
						Decoration.mark({ class: "tuon-selection-overlay__range" }).range(from, to),
				  ])
				: Decoration.none;
			overlay = { ...overlay, from, to };
		} else {
			decorations = Decoration.none;
		}
		return { overlay, decorations };
	},
	provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

class SelectionOverlayView {
	private overlayEl: HTMLDivElement | null = null;

	constructor(private readonly view: EditorView) {
		this.updateOverlay();
	}

	update(_update: ViewUpdate) {
		this.updateOverlay();
	}

	destroy() {
		this.removeOverlay();
	}

	private updateOverlay() {
		const state = this.view.state.field(overlayField, false);
		const overlay = state?.overlay ?? null;
		if (!overlay) {
			this.removeOverlay();
			return;
		}

		if (!this.overlayEl) {
			this.overlayEl = document.createElement("div");
			this.overlayEl.className = "tuon-selection-overlay";
			this.overlayEl.setAttribute("aria-live", "polite");

			const spinner = document.createElement("span");
			spinner.className = "tuon-voice-spinner";
			spinner.style.display = "inline-flex";

			const label = document.createElement("span");
			label.className = "tuon-selection-overlay__label";

			this.overlayEl.appendChild(spinner);
			this.overlayEl.appendChild(label);
			const host = this.view.dom;
			if (getComputedStyle(host).position === "static") {
				host.style.position = "relative";
			}
			host.appendChild(this.overlayEl);
		}

		const labelEl = this.overlayEl.querySelector(".tuon-selection-overlay__label");
		if (labelEl instanceof HTMLElement) {
			labelEl.textContent = overlay.label;
		}

		const coords = this.view.coordsAtPos(overlay.to);
		if (!coords) {
			this.overlayEl.style.display = "none";
			return;
		}

		const host = this.view.dom;
		const hostRect = host.getBoundingClientRect();
		const left = coords.left - hostRect.left + host.scrollLeft;
		const top = coords.bottom - hostRect.top + host.scrollTop + 6;

		this.overlayEl.style.display = "inline-flex";
		this.overlayEl.style.left = `${Math.max(6, left)}px`;
		this.overlayEl.style.top = `${Math.max(6, top)}px`;

		const maxLeft = host.clientWidth - this.overlayEl.offsetWidth - 6;
		if (maxLeft > 6 && left > maxLeft) {
			this.overlayEl.style.left = `${maxLeft}px`;
		}
	}

	private removeOverlay() {
		if (this.overlayEl) {
			this.overlayEl.remove();
			this.overlayEl = null;
		}
	}
}

const overlayExtension = [overlayField, ViewPlugin.fromClass(SelectionOverlayView)];

function ensureOverlayExtension(view: EditorView) {
	const existing = view.state.field(overlayField, false);
	if (existing !== undefined) return;
	view.dispatch({
		effects: StateEffect.appendConfig.of(overlayExtension),
	});
}

export function showSelectionOverlay(
	view: EditorView,
	from: number,
	to: number,
	label: string
): () => void {
	ensureOverlayExtension(view);
	view.dispatch({
		effects: showOverlay.of({ from, to, label }),
	});
	return () => {
		const existing = view.state.field(overlayField, false);
		if (existing === undefined) return;
		view.dispatch({ effects: hideOverlay.of(undefined) });
	};
}
