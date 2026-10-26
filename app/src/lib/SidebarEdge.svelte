<script lang="ts">
	import { clampWidth, DEFAULT_WIDTH } from './sidebar';

	// The sidebar's right edge, dragged to resize it; a double-click sets the
	// default width back. onend follows a drag or a double-click.
	let {
		width,
		onstart,
		onresize,
		onend,
	}: { width: number; onstart: () => void; onresize: (width: number) => void; onend: () => void } = $props();

	let from = $state<{ x: number; width: number }>();

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		// No text selection while dragging.
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		from = { x: e.clientX, width };
		onstart();
	}

	function move(e: PointerEvent) {
		if (from) onresize(clampWidth(from.width + e.clientX - from.x));
	}

	// After a pointerup as well as a cancel, which also release the capture.
	function lost() {
		if (!from) return;
		from = undefined;
		onend();
	}

	function reset() {
		onresize(DEFAULT_WIDTH);
		onend();
	}
</script>

<div
	class="edge"
	class:dragging={from !== undefined}
	role="separator"
	aria-orientation="vertical"
	aria-label="Resize sidebar"
	onpointerdown={down}
	onpointermove={move}
	onlostpointercapture={lost}
	ondblclick={reset}
></div>

<style>
	/* Straddles the sidebar's border, over the terminal's padding. */
	.edge {
		position: absolute;
		top: 0;
		right: -3px;
		bottom: 0;
		z-index: 5;
		width: 6px;
		cursor: col-resize;
	}

	/* A line where the border is, once the pointer has rested on it. */
	.edge::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 2px;
		width: 2px;
		background: transparent;
		transition: background 0.1s;
	}

	.edge:hover::after {
		background: var(--accent);
		transition-delay: 0.3s;
	}

	.edge.dragging::after {
		background: var(--accent);
		transition-delay: 0s;
	}
</style>
