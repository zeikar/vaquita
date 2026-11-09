<script lang="ts">
	import { onDestroy } from 'svelte';
	import { writeClipboard } from './clipboard';
	import Icon from './Icon.svelte';

	let {
		text,
		failed,
		write = writeClipboard,
	}: {
		text: string;
		failed: (e: unknown) => void;
		write?: (text: string) => Promise<void>;
	} = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(timer));

	function click(e: MouseEvent): void {
		// Sanitized HTML may still wrap a code block in a link, which is not
		// what this click is for.
		e.stopPropagation();
		write(text).then(() => {
			copied = true;
			clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1500);
		}, failed);
	}
</script>

<button class="copy" title="Copy" aria-label="Copy" onclick={click}><Icon name={copied ? 'check' : 'square-2-stack'} /></button>

<style>
	.copy {
		position: absolute;
		top: 6px;
		right: 6px;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
		background: #2a2d2e;
		color: #999;
		cursor: pointer;
		opacity: 0;
	}
	:global(.code:hover) .copy,
	.copy:focus-visible {
		opacity: 1;
	}
	.copy:hover {
		background: #3a3d41;
		color: #e5e5e5;
	}
	.copy:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
</style>
