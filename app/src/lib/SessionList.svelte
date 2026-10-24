<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { writeClipboard } from './clipboard';
	import { Confirm } from './confirm.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import { groupRows } from './groups';
	import type { SessionRow } from './manager';
	import type { MenuAt, MenuItem } from './menu';
	import RepoHeader from './RepoHeader.svelte';
	import { canReveal, revealInFinder } from './reveal';
	import SessionItem from './SessionItem.svelte';
	import { load, save } from './storage';

	let {
		sessions,
		selected,
		onselect,
		onkill,
		repos,
		home,
		disabled,
		onreopen,
		ondismiss,
		onstart,
		onremoverepo,
		onrename,
		onreport,
		addDisabled,
		onaddrepo,
		onnewsession,
	}: {
		sessions: SessionRow<unknown>[];
		selected?: number;
		onselect: (sid: number) => void;
		onkill: (sid: number) => void;
		repos: string[];
		// Known only inside Tauri; without it paths stay absolute. Required, so
		// that a caller cannot forget it.
		home: string | undefined;
		disabled: boolean;
		onreopen: (sid: number) => void;
		ondismiss: (sid: number) => void;
		// An empty cmd starts a shell.
		onstart: (repo: string, cmd: string) => void;
		onremoverepo: (path: string) => void;
		onrename: (sid: number, name: string) => void;
		// For a failure the list has nowhere to show.
		onreport: (message: string) => void;
		// As the + button is.
		addDisabled: boolean;
		onaddrepo: () => void;
		onnewsession: () => void;
	} = $props();

	const groups = $derived(groupRows(sessions, repos));

	// What a collapsed group's header shows for its hidden rows.
	const needs = (rows: SessionRow<unknown>[]) =>
		rows.some((r) => r.info.status?.state === 'input') ? 'input' : rows.some((r) => r.info.status?.state === 'auth') ? 'auth' : undefined;

	// Kill and Dismiss take a second click.
	const twoClick = new Confirm();

	// The sid of the row whose name is being edited.
	let editing = $state<number>();

	// The collapsed groups by repo path, "other" for the group without one.
	// Anything unreadable leaves every group open.
	const COLLAPSED = 'vaquita.collapsed';
	function storedCollapsed(): string[] {
		try {
			const v: unknown = JSON.parse(load(COLLAPSED) ?? '[]');
			return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
		} catch (e) {
			console.warn(`${COLLAPSED} is not JSON:`, e);
			return [];
		}
	}
	const collapsed = new SvelteSet(storedCollapsed());
	function toggle(key: string) {
		if (!collapsed.delete(key)) collapsed.add(key);
		save(COLLAPSED, JSON.stringify([...collapsed]));
	}

	// The one context menu. owner says whose it is; key changes on every open,
	// as the menu takes its opener and the focus when it mounts.
	let menu = $state<{ at: MenuAt; items: MenuItem[]; owner: string; stamp: string | undefined; key: number }>();
	let opens = 0;
	function openMenu(owner: string, at: MenuAt, items: MenuItem[]) {
		menu = { at, items, owner, stamp: stamp(owner), key: ++opens };
	}

	// What the open menu's items were built from; undefined once its owner is gone.
	function stamp(owner: string): string | undefined {
		if (owner === 'list') return `${addDisabled}`;
		if (owner.startsWith('repo:')) return groups.some((g) => `repo:${g.repo}` === owner) ? `${disabled}` : undefined;
		const info = sessions.find((r) => `session:${r.info.sid}` === owner)?.info;
		return info && `${info.inc}|${info.restorable}|${disabled}`;
	}

	// The items are a snapshot, so a menu whose basis changed is closed rather than
	// left offering a stale action.
	$effect(() => {
		if (menu && stamp(menu.owner) !== menu.stamp) menu = undefined;
	});

	const failed = (what: string) => (e: unknown) => onreport(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
	const reveal = (path: string): MenuItem[] =>
		canReveal()
			? [{ label: 'Reveal in Finder', disabled: !path, run: () => void revealInFinder(path).catch(failed('reveal in Finder')) }]
			: [];

	// The start items are disabled as the header's buttons are: manager.create
	// refuses silently while disconnected or creating.
	const repoMenu = (repo: string): MenuItem[] => [
		{ label: 'New Claude session', disabled, run: () => onstart(repo, 'claude') },
		{ label: 'New Codex session', disabled, run: () => onstart(repo, 'codex') },
		{ label: 'New shell', disabled, run: () => onstart(repo, '') },
		...reveal(repo),
		{ label: 'Remove repo', danger: true, confirm: true, run: () => onremoverepo(repo) },
	];

	// An empty cwd is the home folder, which the list does not always know.
	// Reopen is disabled as the row's button is.
	function sessionMenu({ info }: SessionRow<unknown>): MenuItem[] {
		const { sid, cwd } = info;
		return [
			{ label: 'Rename', run: () => (editing = sid) },
			{ label: 'Copy path', disabled: !cwd, run: () => void writeClipboard(cwd).catch(failed('copy path')) },
			...reveal(cwd),
			...(info.restorable
				? [
						{ label: 'Reopen', disabled, run: () => onreopen(sid) },
						{ label: 'Dismiss', confirm: true, run: () => ondismiss(sid) },
					]
				: [{ label: 'Kill', danger: true, confirm: true, run: () => onkill(sid) }]),
		];
	}

	// Only on the list's own space: rows and headers open their own menus.
	function listMenu(e: MouseEvent) {
		if (e.target !== e.currentTarget) return;
		e.preventDefault();
		openMenu('list', { x: e.clientX, y: e.clientY }, [
			{ label: 'Add repo…', disabled: addDisabled, run: onaddrepo },
			{ label: 'New session…', run: onnewsession },
		]);
	}
</script>

<ul oncontextmenu={listMenu}>
	{#each groups as g (g.repo ?? '')}
		{@const key = g.repo ?? 'other'}
		{@const owner = `repo:${g.repo}`}
		{@const shut = collapsed.has(key)}
		<RepoHeader
			repo={g.repo}
			collapsed={shut}
			needs={shut ? needs(g.rows) : undefined}
			unread={shut && g.rows.some((r) => r.info.unread)}
			{disabled}
			menuOpen={menu?.owner === owner}
			ontoggle={() => toggle(key)}
			onstart={(cmd) => g.repo !== undefined && onstart(g.repo, cmd)}
			onmenu={(at) => g.repo !== undefined && openMenu(owner, at, repoMenu(g.repo))}
		/>
		{#if !shut}
			{#each g.rows as r (r.info.sid)}
				{@const sid = r.info.sid}
				{@const rowOwner = `session:${sid}`}
				<SessionItem
					row={r}
					{home}
					selected={sid === selected}
					{disabled}
					editing={editing === sid}
					menuOpen={menu?.owner === rowOwner}
					{twoClick}
					onselect={() => onselect(sid)}
					onedit={() => (editing = sid)}
					onrename={(name) => onrename(sid, name)}
					onclose={() => editing === sid && (editing = undefined)}
					onkill={() => onkill(sid)}
					onreopen={() => onreopen(sid)}
					ondismiss={() => ondismiss(sid)}
					onmenu={(at) => openMenu(rowOwner, at, sessionMenu(r))}
				/>
			{/each}
		{/if}
	{/each}
</ul>
{#if menu}
	{#key menu.key}
		<ContextMenu at={menu.at} items={menu.items} onclose={() => (menu = undefined)} />
	{/key}
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 4px 0 0;
		overflow-y: auto;
		flex: 1;
	}
</style>
