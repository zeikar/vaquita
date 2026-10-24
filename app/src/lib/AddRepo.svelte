<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { isTauri } from './tauri';

	let {
		disabled,
		onadd,
	}: {
		disabled: boolean;
		onadd: (path: string) => void;
	} = $props();

	let path = $state('');
	let error = $state('');
	let shown = $state(false);
	let input = $state<HTMLInputElement>();

	async function choose() {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const dir = await open({ directory: true, multiple: false, title: 'Add repo' });
			if (dir !== null) {
				error = '';
				onadd(dir);
			}
		} catch (e) {
			error = `folder picker failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// Also called by the sidebar's menu.
	export async function open() {
		if (isTauri()) return choose();
		shown = true;
		await tick();
		input?.focus();
	}

	function hide() {
		shown = false;
		path = '';
		error = '';
	}

	function keydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			hide();
		} else if (e.key === 'Enter' && !e.isComposing) {
			e.preventDefault();
			const dir = path.trim();
			// The daemon neither expands ~ nor anchors a relative path.
			if (!dir.startsWith('/')) {
				error = 'repo path must be an absolute path';
				return;
			}
			onadd(dir);
			hide();
		}
	}
</script>

<button class="icon-btn" aria-label="Add repo" title="Add repo" {disabled} onclick={open}>
	<Icon name="plus" />
</button>
{#if shown || error}
	<div class="field">
		{#if shown}<input bind:this={input} bind:value={path} placeholder="repo path" onkeydown={keydown} />{/if}
		{#if error}<small role="alert">{error}</small>{/if}
	</div>
{/if}

<style>
	/* The header wraps, so the field lands on its own line under the label. */
	.field {
		flex: 0 0 100%;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 4px 0 2px;
	}
</style>
