<script lang="ts">
	import { onMount } from 'svelte';
	import { Confirm } from './confirm.svelte';
	import { clampToViewport, type MenuAt, type MenuItem } from './menu';

	let { at, items, onclose }: { at: MenuAt; items: MenuItem[]; onclose: () => void } = $props();

	// The element the menu was opened from, which gets the focus back.
	const opener = document.activeElement;
	// Keyed by label: one menu holds no two items of the same name.
	const twoClick = new Confirm();
	let menu: HTMLDivElement;

	// The focus goes back first, so that what an item does with the focus
	// (an editor, a dialog) wins, and a Tab goes on from the opener.
	function close() {
		if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		onclose();
	}

	function choose(item: MenuItem) {
		if (item.disabled) return;
		const run = () => {
			close();
			item.run();
		};
		if (item.confirm) twoClick.click(item.label, run);
		else run();
	}

	const enabled = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];

	// Enter and Space are left to the buttons, whose own click they are.
	function key(e: KeyboardEvent) {
		if (e.key === 'Escape' || e.key === 'Tab') return close();
		const list = enabled();
		const i = list.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (e.key === 'ArrowDown') next = (i + 1) % list.length;
		else if (e.key === 'ArrowUp') next = (i <= 0 ? list.length : i) - 1;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = list.length - 1;
		else return;
		// Also keeps the arrows from scrolling the page, which would close it.
		e.preventDefault();
		list[next]?.focus();
	}

	const outside = (e: PointerEvent) => !menu.contains(e.target as Node) && close();
	// Only a scroll that moves what the menu was opened on, of the page (the
	// window, or the document, which contains it as any ancestor does) or of
	// the list holding it: a terminal printing output scrolls too, and must not
	// close it.
	const scrolled = (e: Event) => (!(e.target instanceof Node) || e.target.contains(opener)) && close();

	onMount(() => {
		(enabled()[0] ?? menu).focus();
		window.addEventListener('pointerdown', outside, true);
		window.addEventListener('blur', close);
		window.addEventListener('scroll', scrolled, true);
		window.addEventListener('resize', close);
		return () => {
			window.removeEventListener('pointerdown', outside, true);
			window.removeEventListener('blur', close);
			window.removeEventListener('scroll', scrolled, true);
			window.removeEventListener('resize', close);
			twoClick.disarm();
		};
	});

	$effect(() => {
		const p = clampToViewport(
			at,
			{ width: menu.offsetWidth, height: menu.offsetHeight },
			{ width: window.innerWidth, height: window.innerHeight },
		);
		menu.style.left = `${p.x}px`;
		menu.style.top = `${p.y}px`;
	});

	// Worded as the row's buttons are: "Confirm kill?".
	const ask = (label: string) => `Confirm ${label[0].toLowerCase()}${label.slice(1)}?`;
</script>

<div class="menu" role="menu" tabindex="-1" bind:this={menu} onkeydown={key}>
	{#each items as item (item.label)}
		{@const armed = twoClick.armed === item.label}
		<button
			role="menuitem"
			tabindex="-1"
			aria-disabled={item.disabled || undefined}
			class:danger={item.danger}
			class:armed
			onclick={() => choose(item)}
			onpointerenter={(e) => item.disabled || e.currentTarget.focus()}
		>
			{armed ? ask(item.label) : item.label}
		</button>
	{/each}
</div>

<style>
	.menu {
		position: fixed;
		z-index: 100;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		/* Measured for the clamp wherever it was put, so as wide as its longest item. */
		width: max-content;
		min-width: 160px;
		padding: 5px;
		/* Lighter than the sidebar it opens over, so it floats above it. */
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		background: #2c2c2d;
		box-shadow:
			0 0 0 0.5px rgba(0, 0, 0, 0.8),
			0 10px 28px rgba(0, 0, 0, 0.45);
		font-size: 13px;
		outline: none;
	}
	button {
		display: flex;
		align-items: center;
		height: 24px;
		padding: 0 8px;
		border: none;
		border-radius: 5px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: default;
		outline: none;
	}
	/* The pointer moves the focus, so the focus is the one lit row. The
	   sidebar's #2a2d2e is too close to the panel to show a keyboard user where
	   they are. */
	button:focus {
		background: var(--accent);
		color: #fff;
	}
	button.danger {
		color: #f48771;
	}
	button.danger:focus {
		color: #fff;
	}
	/* A separator sets a destructive item apart from the ones above it. */
	button.danger:not(:first-child) {
		position: relative;
		margin-top: 9px;
	}
	button.danger:not(:first-child)::before {
		content: '';
		position: absolute;
		top: -5px;
		right: 8px;
		left: 8px;
		height: 1px;
		background: rgba(255, 255, 255, 0.1);
	}
	button.armed {
		background: #c72e2e;
		color: #fff;
	}
	button[aria-disabled='true'] {
		color: #6b6b6b;
	}
</style>
