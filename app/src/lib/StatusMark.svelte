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
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
