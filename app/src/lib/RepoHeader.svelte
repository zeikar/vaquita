<script lang="ts">
	import { repoName } from './groups';
	import Icon from './Icon.svelte';
	import type { MenuAt } from './menu';
	import { SUFFIX } from './notify';

	let {
		repo,
		collapsed,
		needs,
		unread,
		disabled,
		menuOpen,
		ontoggle,
		onstart,
		onmenu,
	}: {
		// None for the group of sessions outside every repo, which has no menu.
		repo?: string;
		collapsed: boolean;
		// What the group's hidden rows would show: one waits on the user, one
		// is unread. Given only while collapsed.
		needs?: 'input' | 'auth';
		unread: boolean;
		disabled: boolean;
		menuOpen: boolean;
		ontoggle: () => void;
		onstart: (cmd: string) => void;
		onmenu: (at: MenuAt) => void;
	} = $props();

	let toggle: HTMLButtonElement;

	// Whether the menu was open when the current press began. A press on ⋯
	// closes it, as any press outside the menu does, and the click that ends
	// the press must then not open it again. Read on the window before the
	// menu's own listener, added when the menu mounts, so after this one. A
	// click from the keyboard (detail 0) comes without a press.
	let pressedOpen = false;

	// The focus calls: WebKit focuses no clicked button, and the menu gives
	// the focus back to what had it when it opened, and closes on a scroll of
	// what holds that.
	function more(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
		if (pressedOpen && e.detail > 0) return;
		e.currentTarget.focus();
		const r = e.currentTarget.getBoundingClientRect();
		onmenu({ x: r.left, y: r.bottom });
	}

	// Prevented for the group without a repo too, or WKWebView shows its own.
	function context(e: MouseEvent) {
		e.preventDefault();
		if (repo === undefined) return;
		toggle.focus();
		onmenu({ x: e.clientX, y: e.clientY });
	}
</script>

<svelte:window onpointerdowncapture={() => (pressedOpen = menuOpen)} />

<li oncontextmenu={context}>
	<button class="toggle" bind:this={toggle} aria-expanded={!collapsed} title={repo ?? 'other'} onclick={() => ontoggle()}>
		<Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
		<span class="name">{repo === undefined ? 'other' : repoName(repo)}</span>
	</button>
	{#if repo !== undefined}
		<span class="actions" class:open={menuOpen}>
			<button aria-label="Start claude in {repo}" title="Start claude in {repo}" {disabled} onclick={() => onstart('claude')}>
				<Icon name="claude" />
			</button>
			<button aria-label="Start codex in {repo}" title="Start codex in {repo}" {disabled} onclick={() => onstart('codex')}>
				<Icon name="openai" />
			</button>
			<button aria-label="Repo menu" title="Repo menu" aria-haspopup="menu" aria-expanded={menuOpen} onclick={more}>
				<Icon name="ellipsis-horizontal" />
			</button>
		</span>
	{/if}
	{#if needs || unread}
		<span class="badges">
			<span class="status {needs}" role={needs && 'img'} aria-label={needs && SUFFIX[needs]}>
				{#if needs === 'input'}<Icon name="exclamation-triangle" />{:else if needs === 'auth'}<Icon name="key" />{/if}
			</span>
			<span class="dot" class:unread role={unread ? 'img' : undefined} aria-label={unread ? 'unread' : undefined}></span>
		</span>
	{/if}
</li>

<style>
	li {
		position: relative;
		display: flex;
		align-items: center;
		gap: 2px;
		margin: 0 6px;
		font-size: 11px;
		color: #999;
	}
	li:not(:first-child) {
		margin-top: 12px;
	}
	button {
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 1px solid #4fc1ff;
		outline-offset: -1px;
	}
	/* The chevron's stroke lines up with the rows' agent icons, whose marks
	   fill more of their box, and the name with their titles. */
	.toggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 22px;
		padding: 0 6px;
		border-radius: 6px;
		text-align: left;
	}
	.toggle > :global(svg) {
		flex: none;
	}
	/* Set apart from the rows' paths, which have the same size; the case is
	   the folder's own. */
	.name {
		color: #bbb;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Always laid out, so showing them moves nothing. Opacity rather than
	   visibility keeps them in the Tab order. */
	.actions {
		flex: none;
		display: flex;
		gap: 2px;
		opacity: 0;
		pointer-events: none;
	}
	li:is(:hover, :has(:focus-visible)) .actions,
	.actions.open {
		opacity: 1;
		pointer-events: auto;
	}
	.actions button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border-radius: 4px;
	}
	.actions button:hover:not(:disabled),
	.actions button[aria-expanded='true'] {
		background: rgba(255, 255, 255, 0.1);
		color: #d4d4d4;
	}
	.actions button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	/* In the rows' status and dot columns, under the actions, which take
	   their place while shown. Clicks go through to the toggle beneath. */
	.badges {
		position: absolute;
		top: 0;
		right: 8px;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		pointer-events: none;
	}
	li:is(:hover, :has(:focus-visible)) .actions ~ .badges,
	.actions.open ~ .badges {
		visibility: hidden;
	}
	.status {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
	}
	.status.input {
		color: #cca700;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.dot.unread {
		background: #4fc1ff;
	}
</style>
