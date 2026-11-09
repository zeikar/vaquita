<script lang="ts">
	import Icon from './Icon.svelte';
	import { SUFFIX } from './notify';
	import type { StatusInfo } from './protocol';

	let { status }: { status?: StatusInfo } = $props();

	// What the icon says without a message: the words notifications use.
	const WORDS: Record<StatusInfo['state'], string> = { working: 'working', ...SUFFIX };

	const said = $derived(status && (status.msg || WORDS[status.state]));
</script>

<span class="status {status?.state}" role={status && 'img'} aria-label={said} title={said}>
	{#if status?.state === 'working'}<span class="spinner"></span>
	{:else if status?.state === 'input'}<Icon name="exclamation-triangle" />
	{:else if status?.state === 'auth'}<Icon name="key" />
	{:else if status?.state === 'done'}<Icon name="check" />
	{:else if status?.state === 'error'}<Icon name="x-circle" />{/if}
</span>

<style>
	.status {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
	}
	.status.input {
		color: #cca700;
	}
	.status.done {
		color: #89d185;
	}
	.status.error {
		color: #f14c4c;
	}
	.spinner {
		box-sizing: border-box;
		width: 12px;
		height: 12px;
		border: 2px solid #555;
		border-top-color: var(--neon);
		border-radius: 50%;
		transform: rotate(var(--spinner-angle));
		animation: spin 0.8s steps(24) infinite;
	}
	/* The angle, not the transform, is what animates: WKWebView hands an animated
	   transform to Core Animation, and there it stopped on screen, while still
	   running for the page, after going back and forth between a file's tab and
	   a session's. A custom property is animated by the page itself. */
	@property --spinner-angle {
		syntax: '<angle>';
		inherits: false;
		initial-value: 0deg;
	}
	@keyframes spin {
		to {
			--spinner-angle: 360deg;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
