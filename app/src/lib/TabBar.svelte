<script lang="ts">
	import Icon from './Icon.svelte';
	import { fileName } from './tabs';

	let {
		title,
		tabs,
		active,
		dirty,
		onselect,
		onclose,
	}: {
		// The terminal tab's text: the selected session's title.
		title: string;
		tabs: string[];
		// The file tab shown; undefined is the terminal.
		active?: string;
		dirty: ReadonlySet<string>;
		onselect: (path: string | undefined) => void;
		onclose: (path: string) => void;
	} = $props();
</script>

<div class="tabs" role="tablist">
	<div class="tab" class:active={active === undefined}>
		<button class="name" role="tab" aria-selected={active === undefined} title="{title} (⌘1)" onclick={() => onselect(undefined)}>
			<Icon name="command-line" />
			<span class="label">{title}</span>
		</button>
	</div>
	{#each tabs as path (path)}
		<div class="tab" class:active={active === path}>
			<button class="name" role="tab" aria-selected={active === path} title={path} onclick={() => onselect(path)}>
				<span class="label">{fileName(path)}</span>
				{#if dirty.has(path)}<span class="dirty" role="img" aria-label="Unsaved" title="Unsaved"></span>{/if}
			</button>
			<button class="icon-btn close" aria-label="Close {fileName(path)}" title="Close" onclick={() => onclose(path)}>
				<Icon name="x-mark" />
			</button>
		</div>
	{/each}
</div>

<style>
	/* The sidebar's grey, so the bar reads as part of the window's frame; the
	   shown tab takes the content's background, as if lifted out of it. */
	.tabs {
		display: flex;
		flex: none;
		height: 30px;
		overflow-x: auto;
		overflow-y: hidden;
		border-bottom: 1px solid #333;
		background: #252526;
		color: #999;
		font-size: 12px;
		-webkit-user-select: none;
		user-select: none;
	}
	.tab {
		display: flex;
		flex: none;
		align-items: center;
		max-width: 220px;
		border-right: 1px solid #333;
	}
	.tab.active {
		background: #1e1e1e;
		color: #d4d4d4;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		height: 100%;
		padding: 0 10px;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.tab:has(.close) .name {
		padding-right: 4px;
	}
	.name:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dirty {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
	.close {
		flex: none;
		margin-right: 6px;
	}
</style>
