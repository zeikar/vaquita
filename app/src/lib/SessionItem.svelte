<script lang="ts">
	import { agentIcon, agentKind } from './agent';
	import type { Confirm } from './confirm.svelte';
	import Icon from './Icon.svelte';
	import type { MenuAt } from './menu';
	import NameEditor from './NameEditor.svelte';
	import type { SessionRow } from './manager';
	import { sessionTitle, SUFFIX } from './notify';
	import { shortPath } from './paths';
	import { STATE_EXITED, type StatusInfo } from './protocol';

	let {
		row,
		home,
		selected,
		disabled,
		editing,
		menuOpen,
		twoClick,
		onselect,
		onedit,
		onrename,
		onclose,
		onkill,
		onreopen,
		ondismiss,
		onmenu,
	}: {
		row: SessionRow<unknown>;
		home?: string;
		selected: boolean;
		disabled: boolean;
		editing: boolean;
		menuOpen: boolean;
		// The list's, so that one armed button disarms another.
		twoClick: Confirm;
		onselect: () => void;
		onedit: () => void;
		onrename: (name: string) => void;
		onclose: () => void;
		onkill: () => void;
		onreopen: () => void;
		ondismiss: () => void;
		onmenu: (at: MenuAt) => void;
	} = $props();

	// What the status icon says without a message: the words notifications use.
	const WORDS: Record<StatusInfo['state'], string> = { working: 'working', ...SUFFIX };

	const info = $derived(row.info);
	const s = $derived(info.status);
	const said = $derived(s && (s.msg || WORDS[s.state]));
	const kind = $derived(agentKind(info));
	// A record is dismissed, a session killed; both take a second click.
	const end = $derived(info.restorable ? 'Dismiss' : 'Kill');
	const key = $derived(`${end.toLowerCase()}:${info.sid}`);
	const armed = $derived(twoClick.armed === key);
	const ask = $derived(`Confirm ${end.toLowerCase()}?`);
	const detail = $derived.by(() => {
		if (s?.msg) return s.msg;
		if (info.restorable) return 'from an earlier run';
		if (info.state === STATE_EXITED) {
			const orphans = info.orphans?.length ? ` · orphans: ${info.orphans.join(', ')}` : '';
			return `exited (${info.code})${orphans}`;
		}
		return shortPath(info.cwd, home);
	});
	const tip = $derived(
		[
			info.cwd || '~',
			row.ro && 'read-only',
			row.reports > 0 && `reports: ${row.reports}`,
			row.resets > 0 && `resets: ${row.resets}`,
		]
			.filter(Boolean)
			.join('\n'),
	);

	const disarm = () => armed && twoClick.disarm();

	let button = $state<HTMLButtonElement>();

	// While the name is edited the input keeps the platform's text menu: one
	// here would take the focus from it, which commits. Elsewhere WKWebView's
	// own is prevented. The focus call: WebKit focuses no clicked button, and
	// the menu gives the focus back to what had it when it opened.
	function context(e: MouseEvent) {
		if (editing) return;
		e.preventDefault();
		button?.focus();
		onmenu({ x: e.clientX, y: e.clientY });
	}
</script>

<!-- The status and the dot keep their slots when empty, so rows do not jump. -->
{#snippet body()}
	<span class="line">
		<span class="agent" title={kind}><Icon name={agentIcon(kind)} /></span>
		{#if editing}
			<NameEditor name={info.name} placeholder={sessionTitle({ ...info, name: '' })} {onrename} {onclose} />
		{:else}
			<span class="title" class:unread={info.unread} title={sessionTitle(info)}>{sessionTitle(info)}</span>
		{/if}
		<span class="status {s?.state}" role={s && 'img'} aria-label={said} title={said}>
			{#if s?.state === 'working'}<span class="spinner"></span>
			{:else if s?.state === 'input'}<Icon name="exclamation-triangle" />
			{:else if s?.state === 'auth'}<Icon name="key" />
			{:else if s?.state === 'done'}<Icon name="check" />
			{:else if s?.state === 'error'}<Icon name="x-circle" />{/if}
		</span>
		<span class="dot" class:unread={info.unread}></span>
	</span>
	<span class="detail {s?.msg && s.state}">{detail}</span>
{/snippet}

<li class:selected class:editing class:menu={menuOpen} class:restorable={info.restorable} onpointerleave={disarm} oncontextmenu={context}>
	<!-- While its name is edited a row is no button: a button may not hold
	     an input, and the input's clicks would select the row. -->
	{#if editing}
		<div class="row">{@render body()}</div>
	{:else}
		<!-- The button takes the double-click, as a span cannot without a role;
		     only one on the title renames. A record of an earlier run has no
		     screen to show, so a click reopens it, and it is renamed from its
		     menu: a double-click's first click would already have reopened it. -->
		<button
			class="row"
			bind:this={button}
			title={tip}
			onclick={() => (info.restorable && !disabled ? onreopen() : onselect())}
			ondblclick={(e) => !info.restorable && (e.target as Element).closest('.title') && onedit()}
		>
			{@render body()}
		</button>
	{/if}
	<span class="actions" class:armed class:open={menuOpen}>
		{#if info.restorable}
			<button aria-label="Reopen" title="Reopen" {disabled} onclick={() => onreopen()}>
				<Icon name="arrow-uturn-left" />
			</button>
		{/if}
		<button
			aria-label={armed ? ask : end}
			title={end}
			class:armed
			onclick={() => twoClick.click(key, info.restorable ? ondismiss : onkill)}
			onblur={disarm}
		>
			{#if armed}{ask}{:else}<Icon name="x-mark" />{/if}
		</button>
	</span>
</li>

<style>
	li {
		position: relative;
		display: flex;
		margin: 0 6px;
		border-radius: 6px;
		/* What the actions paint over the end of line 1. */
		--bg: #252526;
		background: var(--bg);
	}
	li:hover {
		--bg: #2c2c2d;
	}
	li.selected {
		--bg: #37373a;
	}
	/* The row a menu was opened on, as the menu covers the pointer. */
	li.menu {
		outline: 2px solid rgba(79, 193, 255, 0.5);
		outline-offset: -2px;
	}
	/* A session from an earlier run steps back behind the live ones. */
	li.restorable:not(.selected) .title {
		color: #a6a6a6;
	}
	li.restorable:not(.selected) .agent {
		opacity: 0.55;
	}
	.row {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		padding: 4px 8px;
		border: none;
		border-radius: inherit;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	div.row {
		cursor: auto;
	}
	button:focus-visible {
		outline: 1px solid #4fc1ff;
		outline-offset: -1px;
	}
	/* Both lines have a fixed height, so a state, an icon or the editor cannot
	   change a row's. */
	.line {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 18px;
	}
	.agent,
	.status,
	.actions button {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.agent,
	.status {
		width: 14px;
		height: 14px;
	}
	.agent {
		color: #999;
	}
	.title,
	.detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title {
		flex: 1;
		min-width: 0;
	}
	.title.unread {
		font-weight: 600;
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
		border-top-color: #4fc1ff;
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
	.dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.dot.unread {
		background: #4fc1ff;
	}
	.detail {
		height: 16px;
		line-height: 16px;
		/* Under the title, past the agent icon and its gap. */
		padding-left: 20px;
		font-size: 11px;
		color: #999;
	}
	/* #999 is too faint on the selection for its size. */
	li.selected .detail:not(.input, .auth) {
		color: #aaa;
	}
	/* What the session waits on, readable at a glance. */
	.detail:is(.input, .auth) {
		color: #cca700;
	}
	/* Over the end of the title, fading into it, so showing them moves nothing;
	   their icons end 3px past where the title does (8 + 6 + 6 + 14 + 6 from
	   the right, less the buttons' 2px padding), as the x-mark's strokes sit
	   inside its box: the gaps to the status and the dot look even, and the
	   status and its tooltip stay in view. Opacity rather than visibility
	   keeps them in the Tab order. */
	.actions {
		position: absolute;
		top: 4px;
		right: 35px;
		display: flex;
		gap: 2px;
		height: 18px;
		padding-left: 8px;
		background: linear-gradient(to right, transparent, var(--bg) 8px);
		opacity: 0;
		pointer-events: none;
	}
	/* A keyboard focus only: a clicked row keeps the focus in Chrome, and one
	   whose menu closed gets it back, and neither should keep them shown. */
	li:not(.editing):is(:hover, :has(:focus-visible)) .actions,
	.actions.armed,
	.actions.open {
		opacity: 1;
		pointer-events: auto;
	}
	.actions button {
		min-width: 18px;
		height: 18px;
		padding: 0 2px;
		border: none;
		border-radius: 4px;
		background: none;
		color: #999;
		cursor: pointer;
	}
	.actions button:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.1);
		color: #d4d4d4;
	}
	.actions button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.actions button.armed {
		padding: 0 4px;
		color: #f48771;
		font-size: 11px;
		white-space: nowrap;
	}
</style>
