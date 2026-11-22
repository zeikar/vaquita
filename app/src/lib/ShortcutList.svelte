<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { chordLabel, SHORTCUTS, type Key } from './shortcut-list';

	let {
		onclose,
		fallbackFocus,
	}: {
		onclose: () => void;
		// Takes the focus on close when what had it at the open cannot, as in
		// NewSessionDialog.
		fallbackFocus: () => void;
	} = $props();

	let dialog: HTMLDialogElement;
	let scroller: HTMLDivElement;
	let closer: HTMLButtonElement;
	// Set as the list goes, when its own close is no request to close.
	let gone = false;
	// The last press began on the backdrop.
	let pressedOutside = false;
	// The scroller shows its ring only once Tab moved through the list: on
	// open it would frame the whole list, as WebKit counts the typing before.
	let tabbed = $state(false);

	const label = (k: Key) => (k.by === 'mouse' ? k.label : chordLabel(k.chord));

	// Mounted only while open, so every open starts afresh, scrolled to the
	// top. The scroller takes the focus, so the arrow keys scroll it.
	onMount(() => {
		const opener = document.activeElement;
		dialog.showModal();
		scroller.focus();
		return () => {
			gone = true;
			giveFocusBack(opener);
		};
	});

	// As NewSessionDialog's: the platform's own return of the focus differs
	// between engines. Closed first, as the page behind a modal dialog takes
	// no focus while it is still open there.
	function giveFocusBack(opener: Element | null) {
		if (dialog.open) dialog.close();
		if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
		const now = document.activeElement;
		if (!now || now === document.body || dialog.contains(now)) fallbackFocus();
	}

	// Escape is prevented, as the platform would follow it with a cancel: one
	// press closes once. Tab stays inside, where WebKit would skip the button.
	function key(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			e.preventDefault();
			tabbed = true;
			(document.activeElement === closer ? scroller : closer).focus();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	// The list goes only when the state in Tabs turns false.
	function cancel(e: Event) {
		e.preventDefault();
		onclose();
	}

	// The platform may close it past a prevented cancel, as after a second
	// Escape; the state in Tabs follows, or it would stay open with nothing
	// shown.
	function closed() {
		if (!gone) onclose();
	}

	// The backdrop is the dialog element itself to a click, as is the
	// dialog's own padding; only the point tells them apart. A control's
	// click from the keyboard may come at (0, 0), so the point is asked only
	// when the dialog is the target.
	function outside(e: MouseEvent): boolean {
		if (e.target !== dialog) return false;
		const r = dialog.getBoundingClientRect();
		return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
	}

	// A press on the title or the padding would leave the focus on the page,
	// which the dialog does not take, so it keeps the focus where it is in
	// the list. The rows' scroller and the button take it themselves.
	function press(e: MouseEvent) {
		pressedOutside = outside(e);
		tabbed = false;
		const t = e.target as Node;
		if (scroller.contains(t) || closer.contains(t)) return;
		e.preventDefault();
		if (!dialog.contains(document.activeElement)) scroller.focus();
	}

	// Only a press and release both on the backdrop: a drag out of the list
	// that ends there clicks the dialog too.
	function click(e: MouseEvent) {
		if (pressedOutside && outside(e)) onclose();
	}
</script>

<dialog bind:this={dialog} aria-labelledby="shortcuts-title" onkeydown={key} oncancel={cancel} onclose={closed} onmousedown={press} onclick={click}>
	<header>
		<h2 id="shortcuts-title">Keyboard shortcuts</h2>
		<button type="button" class="close" title="Close" aria-label="Close" bind:this={closer} onclick={() => onclose()}>
			<Icon name="x-mark" />
		</button>
	</header>
	<div class="scroller" class:tabbed role="region" aria-labelledby="shortcuts-title" tabindex="-1" bind:this={scroller}>
		<div class="sections">
			{#each SHORTCUTS as section (section.title)}
				<section>
					<h3>{section.title}</h3>
					<ul>
						{#each section.entries as entry (entry.does)}
							<li>
								<span class="does">{entry.does}</span>
								<span class="keys">
									{#if entry.range}
										<kbd>{label(entry.keys[0])}</kbd><span class="sep">–</span><kbd>{label(entry.keys[entry.keys.length - 1])}</kbd>
									{:else}
										{#each entry.keys as k, i (i)}
											{#if i > 0}<span class="sep">or</span>{/if}<kbd>{label(k)}</kbd>
										{/each}
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</div>
</dialog>

<style>
	/* The new-session dialog's panel, wider, with its rows scrolling under a
	   title row that stays. */
	dialog {
		box-sizing: border-box;
		width: min(760px, calc(100vw - 32px));
		max-width: none;
		max-height: calc(100vh - 64px);
		padding: 16px 16px 12px;
		border: 1px solid #333;
		border-radius: 8px;
		background: #252526;
		color: #d4d4d4;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
		-webkit-user-select: none;
		user-select: none;
	}
	/* Only while open: a display on the closed dialog would show it. */
	dialog[open] {
		display: flex;
		flex-direction: column;
	}
	dialog::backdrop {
		background: rgba(0, 0, 0, 0.5);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex: none;
		margin-bottom: 8px;
		padding: 0 4px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.close {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		margin-right: -4px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #999;
		cursor: pointer;
	}
	.close:hover {
		background: rgba(255, 255, 255, 0.08);
		color: #d4d4d4;
	}
	.close:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: 0;
	}
	.scroller {
		min-height: 0;
		overflow-y: auto;
		padding: 0 4px;
		border-radius: 4px;
		outline: none;
	}
	/* Inset, as the scroller clips what is drawn outside it; its side
	   padding keeps the ring off the keys. */
	.scroller.tabbed:focus {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
	/* Two columns once the dialog is 640 px wide. They sit inside the
	   scroller, at their own height, so a short window scrolls them rather
	   than adding columns to the side. A section never splits. */
	@media (min-width: 672px) {
		.sections {
			columns: 2;
			column-gap: 40px;
		}
	}
	section {
		break-inside: avoid;
		padding: 4px 0 8px;
	}
	h3 {
		margin: 0 0 2px;
		padding-bottom: 4px;
		border-bottom: 1px solid #333;
		font-size: 11px;
		font-weight: 600;
		color: #999;
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 28px;
	}
	.keys {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}
	/* A key cap: the bottom edge is the one detail. */
	kbd {
		box-sizing: border-box;
		min-width: 22px;
		padding: 1px 6px;
		border: 1px solid #3c3c3c;
		border-bottom-width: 2px;
		border-radius: 4px;
		background: #1e1e1e;
		font: 12px -apple-system, system-ui, sans-serif;
		text-align: center;
		color: #d4d4d4;
	}
	.sep {
		font-size: 11px;
		color: #8b8b8b;
	}
</style>
