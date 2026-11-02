<script lang="ts">
	import { agentIcon, agentKind } from './agent';
	import { diffPath, tabFile } from './changes';
	import { writeClipboard } from './clipboard';
	import ContextMenu from './ContextMenu.svelte';
	import Icon from './Icon.svelte';
	import type { SessionRow } from './manager';
	import type { MenuAt, MenuItem } from './menu';
	import { sessionTitle } from './notify';
	import { STATE_EXITED } from './protocol';
	import { canReveal, revealInFinder } from './reveal';
	import { isSessionTab, tabSid } from './session-tabs';
	import StatusMark from './StatusMark.svelte';
	import { fileName, moveTab } from './tabs';

	let {
		tabs,
		sessions,
		active,
		preview,
		dirty,
		onselect,
		onclose,
		onpin,
		onreorder,
		onnew,
		report,
	}: {
		// File, diff and session keys, in the group's order.
		tabs: string[];
		// What session tabs show; a session key with no row here has no tab.
		sessions: SessionRow<unknown>[];
		// The tab shown; a repo's welcome, which is no tab, leaves none marked.
		active?: string;
		// The tab the next opened file takes the place of, in italics.
		preview?: string;
		dirty: ReadonlySet<string>;
		onselect: (key: string) => void;
		onclose: (keys: string[]) => void;
		// A double-click keeps the preview tab.
		onpin: (path: string) => void;
		// The tabs in the order a drag left them, once on release.
		onreorder: (order: string[]) => void;
		onnew: () => void;
		report: (message: string) => void;
	} = $props();

	const rowOf = $derived(new Map(sessions.map((r) => [r.info.sid, r])));
	const infoOf = (key: string) => {
		const sid = tabSid(key);
		return sid === undefined ? undefined : rowOf.get(sid)?.info;
	};

	let bar: HTMLElement;

	// The scrollbar is hidden, so the wheel is how a long row is reached: a
	// vertical wheel scrolls it sideways. Horizontal gestures are left alone.
	// Added by hand because Svelte's wheel handlers are passive and could not
	// cancel the vertical scroll.
	$effect(() => {
		const onwheel = (e: WheelEvent) => {
			if (bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
			e.preventDefault();
			bar.scrollLeft += e.deltaY;
		};
		bar.addEventListener('wheel', onwheel, { passive: false });
		return () => bar.removeEventListener('wheel', onwheel);
	});

	// Keep the shown tab visible when it changes or a tab opens off-screen.
	$effect(() => {
		void [active, tabs.length];
		bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

	// The one context menu; key changes on every open, as the menu takes its
	// opener and the focus when it mounts. shown is the tab shown when it opened.
	let menu = $state<{ at: MenuAt; items: MenuItem[]; path: string; shown?: string; key: number }>();
	let opens = 0;

	// The menu gives the focus back to what had it when it opened, which a file
	// shown since may cover, so it is dropped (unmounting gives no focus back)
	// once its tab is gone or another tab shows: showTab focuses what shows.
	$effect(() => {
		if (menu && (!tabs.includes(menu.path) || active !== menu.shown)) menu = undefined;
	});

	// Enough travel that a click with a shaky hand stays a click.
	const DRAG_PX = 6;

	// A press on a tab; order is set once it moved far enough to be a
	// drag, and the bar shows it until release.
	let drag = $state<{ path: string; x: number; pointerId: number; order?: string[] }>();
	// The click the browser fires after a drag: a drag arranges tabs and shows
	// none. Set when the drag starts, not at release, so it does not matter
	// whether the click comes before or after the capture is lost.
	let swallow = false;

	// The capture is taken at the threshold, on the bar, not on the button: the
	// bar is never moved, while reordering moves the button's own element, which
	// would release a capture held there and lose the end of the drag. Before
	// the threshold nothing is captured, so a plain click stays on its button.
	function down(e: PointerEvent, path: string) {
		if (e.button !== 0) return;
		drag = { path, x: e.clientX, pointerId: e.pointerId };
		swallow = false;
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		// A release outside the bar before the threshold was never seen.
		if (e.buttons === 0) {
			drag = undefined;
			return;
		}
		if (!drag.order) {
			if (Math.abs(e.clientX - drag.x) < DRAG_PX) return;
			bar.setPointerCapture(e.pointerId);
			// The drawn tabs only, so a position counted on screen is one in the
			// order; setOrder puts an undrawn key back.
			drag.order = tabs.filter((k) => !isSessionTab(k) || infoOf(k));
			swallow = true;
		}
		// The others' centres as laid out now: the dragged tab goes after every
		// one left of the pointer.
		const { path } = drag;
		const at = [...bar.querySelectorAll<HTMLElement>('.tab[data-path]')].filter((t) => {
			if (t.dataset.path === path) return false;
			const r = t.getBoundingClientRect();
			return r.left + r.width / 2 < e.clientX;
		}).length;
		drag.order = moveTab(drag.order, path, at);
	}

	// On the up, the cancel and the lost capture, whichever comes first. A tab
	// placed by hand is kept: the next opened file must not take its place. A
	// preview is always a file's, never a session's.
	function lost() {
		const d = drag;
		drag = undefined;
		if (!d?.order) return;
		onreorder(d.order);
		if (d.path === preview) onpin(d.path);
	}

	function click(path: string) {
		if (swallow) swallow = false;
		else onselect(path);
	}

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const failed = (what: string) => (e: unknown) => report(`${what} failed: ${message(e)}`);

	const pathItems = (path: string): MenuItem[] => [
		{ label: 'Copy path', run: () => void writeClipboard(path).catch(failed('copy path')) },
		...(canReveal() ? [{ label: 'Reveal in Finder', run: () => void revealInFinder(path).catch(failed('reveal in Finder')) }] : []),
	];

	// The ones that close several close file tabs only: one menu item never
	// kills several sessions.
	const files = (keys: string[]) => keys.filter((k) => !isSessionTab(k));

	// No focus call, unlike the tree's rows: the focus stays on the content
	// under the bar, where the menu gives it back and typing belongs. The items
	// read tabs when clicked, not when the menu opened.
	function context(e: MouseEvent, path: string) {
		e.preventDefault();
		const info = infoOf(path);
		// Kill takes one click: closing a working session's tab asks first.
		const items: MenuItem[] = info
			? [{ label: 'Kill', danger: true, run: () => onclose([path]) }, ...pathItems(info.cwd)]
			: [
					{ label: 'Close', run: () => onclose([path]) },
					{
						label: 'Close Others',
						disabled: files(tabs).length < 2,
						// Shown first, so the shown tab survives and nothing falls back.
						run: () => {
							onselect(path);
							onclose(files(tabs).filter((p) => p !== path));
						},
					},
					{
						label: 'Close to the Right',
						disabled: files(tabs.slice(tabs.indexOf(path) + 1)).length === 0,
						run: () => onclose(files(tabs.slice(tabs.indexOf(path) + 1))),
					},
					{ label: 'Close All', run: () => onclose(files(tabs)) },
					// A diff tab's are its file's.
					...pathItems(tabFile(path)),
				];
		menu = { at: { x: e.clientX, y: e.clientY }, items, path, shown: active, key: ++opens };
	}
</script>

<!-- svelte-ignore a11y_interactive_supports_focus: the handlers only follow a drag; the tabs inside are the focusable parts. -->
<div
	class="tabs"
	role="tablist"
	bind:this={bar}
	onpointermove={move}
	onpointerup={lost}
	onpointercancel={lost}
	onlostpointercapture={lost}
>
	{#each drag?.order ?? tabs as path (path)}
		{@const info = infoOf(path)}
		<!-- A session key with no row is on its way out of the order. -->
		{#if info || !isSessionTab(path)}
			{@const exited = info?.state === STATE_EXITED}
			{@const name = info ? sessionTitle(info) : `${fileName(tabFile(path))}${diffPath(path) !== undefined ? ' diff' : ''}`}
			<!-- presentation: the list's tabs are the buttons; this only holds the
			     menu's handler. data-path is the tab key, which the drag and the
			     browser checks find tabs by. -->
			<div
				class="tab"
				role="presentation"
				data-path={path}
				class:active={active === path}
				class:preview={path === preview}
				class:exited
				class:menu={menu?.path === path}
				class:dragging={drag?.order !== undefined && drag.path === path}
				oncontextmenu={(e) => context(e, path)}
			>
				<!-- Pinning is a file matter: a session tab takes no double-click. -->
				<button
					class="name"
					role="tab"
					aria-selected={active === path}
					title={info ? [info.cwd || '~', exited && `exited (${info.code})`].filter(Boolean).join('\n') : tabFile(path)}
					onpointerdown={(e) => down(e, path)}
					onpointermove={move}
					onlostpointercapture={lost}
					onclick={() => click(path)}
					ondblclick={info ? undefined : () => onpin(path)}
				>
					{#if info}
						<Icon name={agentIcon(agentKind(info))} />
						<span class="label">{name}</span>
						<StatusMark status={info.status} />
						<span class="dot" class:unread={info.unread}></span>
					{:else}
						<span class="label">{fileName(tabFile(path))}</span>
						{#if diffPath(path) !== undefined}<span class="mark">diff</span>{/if}
						{#if dirty.has(path)}<span class="dirty" role="img" aria-label="Unsaved" title="Unsaved"></span>{/if}
					{/if}
				</button>
				<button class="icon-btn close" aria-label="Close {name}" title="Close" onclick={() => onclose([path])}>
					<Icon name="x-mark" />
				</button>
			</div>
		{/if}
	{/each}
	<button class="icon-btn new" aria-label="New session" title="New session (⌘T)" onclick={onnew}>
		<Icon name="plus" />
	</button>
</div>

{#if menu}
	{#key menu.key}
		<ContextMenu at={menu.at} items={menu.items} onclose={() => (menu = undefined)} />
	{/key}
{/if}

<style>
	/* The sidebar's grey, so the bar reads as part of the window's frame; the
	   shown tab takes the content's background, as if lifted out of it. */
	.tabs {
		display: flex;
		flex: none;
		height: 30px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
		border-bottom: 1px solid #333;
		background: #252526;
		color: #999;
		font-size: 12px;
		-webkit-user-select: none;
		user-select: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	.tab {
		display: flex;
		flex: none;
		align-items: center;
		max-width: 220px;
		border-right: 1px solid #333;
	}
	/* A dragged tab is lifted as the shown one is, with nothing in the layout
	   changing. */
	.tab.active,
	.tab.dragging {
		background: #1e1e1e;
		color: #d4d4d4;
	}
	/* The tab a menu was opened on, as the tree marks its row. */
	.tab.menu {
		outline: 2px solid rgba(79, 193, 255, 0.5);
		outline-offset: -2px;
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
	.tab.preview .label {
		font-style: italic;
	}
	.tab.exited .label {
		color: #777;
	}
	.mark {
		flex: none;
		color: #777;
		font-size: 10px;
	}
	.dirty {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
	.dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.dot.unread {
		background: var(--neon);
	}
	.close {
		flex: none;
		margin-right: 6px;
	}
	.new {
		flex: none;
		align-self: center;
		margin: 0 5px;
	}
</style>
