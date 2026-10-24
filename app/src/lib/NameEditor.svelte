<script lang="ts">
	import { untrack } from 'svelte';
	import { belongsToIME } from './keys';

	let {
		name,
		placeholder,
		onrename,
		onclose,
	}: {
		// Read once, when editing starts, so that a list update while typing
		// changes neither it nor the text typed so far.
		name: string;
		placeholder: string;
		// Called on commit only when the trimmed name differs from name.
		onrename: (name: string) => void;
		onclose: () => void;
	} = $props();

	const from = untrack(() => name);
	let draft = $state(from);
	// Enter or Escape is followed by a blur, which then finds nothing to do.
	let closed = false;

	function close() {
		closed = true;
		onclose();
	}

	function commit() {
		if (closed) return;
		close();
		const next = draft.trim();
		if (next !== from) onrename(next);
	}

	function editKey(e: KeyboardEvent) {
		// An Enter or Escape that ends an IME composition is the IME's.
		if (belongsToIME(e)) return;
		if (e.key === 'Enter') commit();
		else if (e.key === 'Escape') close();
	}

	function focusInput(el: HTMLInputElement) {
		el.focus();
		el.select();
	}
</script>

<input
	aria-label="Session name"
	{placeholder}
	bind:value={draft}
	onkeydown={editKey}
	onblur={commit}
	use:focusInput
/>

<style>
	/* The row's line keeps its height: the border is inside the 18px. */
	input {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		height: 18px;
		padding: 0 2px;
		border: 1px solid #4fc1ff;
		border-radius: 3px;
		outline: none;
		background: #1e1e1e;
		color: inherit;
		font: inherit;
	}
</style>
