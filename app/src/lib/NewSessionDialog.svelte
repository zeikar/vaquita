<script module lang="ts">
	// Where the last session was created from the dialog.
	export const LAST_CWD = 'vaquita.cwd';
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { agentIcon, type AgentKind } from './agent';
	import { repoName } from './groups';
	import Icon from './Icon.svelte';
	import { belongsToIME } from './keys';
	import { save } from './storage';

	let {
		open,
		repos,
		defaultCwd,
		disabled,
		oncreate,
		onclose,
		fallbackFocus,
	}: {
		open: boolean;
		repos: string[];
		// Read when the dialog opens. Empty is the home folder.
		defaultCwd: string;
		disabled: boolean;
		// An empty cmd starts a shell.
		// Resolves true once the session exists, false if it could not be created.
		oncreate: (cwd: string, cmd: string, name: string) => Promise<boolean>;
		onclose: () => void;
		// Takes the focus on close when what had it at the open cannot: it is
		// gone, as a menu item is by then, or it was the page itself, as after
		// a click on a button, which WebKit does not focus.
		fallbackFocus: () => void;
	} = $props();

	const kinds: { kind: AgentKind; cmd: string; label: string }[] = [
		{ kind: 'shell', cmd: '', label: 'Shell' },
		{ kind: 'claude', cmd: 'claude', label: 'Claude' },
		{ kind: 'codex', cmd: 'codex', label: 'Codex' },
	];

	let dialog: HTMLDialogElement;
	let folder: HTMLInputElement;
	// What had the focus when the dialog opened.
	let opener: Element | null = null;
	let cwd = $state('');
	let cmd = $state('');
	let name = $state('');
	let error = $state('');
	// Set from the submit until the create ends. The attempt number lets a
	// create that ends after the dialog was closed and opened again be ignored.
	let waiting = $state(false);
	let attempt = 0;

	// The select shows a repo only while the path is that repo.
	const repo = $derived(repos.includes(cwd.trim()) ? cwd.trim() : '');

	// Every open starts afresh. The path is focused here, after showModal(),
	// whose own choice of focus differs between engines.
	$effect(() => {
		if (!open) {
			if (dialog.open) {
				dialog.close();
				untrack(giveFocusBack);
			}
			return;
		}
		opener = document.activeElement;
		untrack(() => {
			cwd = defaultCwd;
			cmd = '';
			name = '';
			error = '';
			waiting = false;
			attempt++;
		});
		dialog.showModal();
		folder.focus();
	});

	// The platform's own return of the focus differs between engines too, and
	// may leave it on the closed dialog.
	function giveFocusBack() {
		if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
		opener = null;
		const now = document.activeElement;
		if (!now || now === document.body || dialog.contains(now)) fallbackFocus();
		if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) document.activeElement.blur();
	}

	// Tab goes round the controls here: the platform's order leaves the
	// dialog after its last one and, in WebKit without Full Keyboard Access,
	// skips all but the text fields. The kinds are one stop, as radios are.
	function tab(e: KeyboardEvent) {
		const stops = [...dialog.querySelectorAll<HTMLElement>('select, input:not([type="radio"]), input:checked, button:not(:disabled)')];
		const i = stops.indexOf(document.activeElement as HTMLElement);
		const n = stops.length;
		e.preventDefault();
		stops[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n]?.focus();
	}

	// Prevented, as the platform would follow it with a cancel: one Escape
	// closes once, and one that belongs to an IME, ending its composition,
	// not at all.
	function key(e: KeyboardEvent) {
		if (e.key === 'Tab' && !belongsToIME(e)) return tab(e);
		if (e.key !== 'Escape') return;
		e.preventDefault();
		if (!belongsToIME(e)) onclose();
	}

	// The dialog closes only when open turns false.
	function cancel(e: Event) {
		e.preventDefault();
		onclose();
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const dir = cwd.trim();
		// The daemon neither expands ~ nor anchors a relative path.
		if (dir !== '' && !dir.startsWith('/')) {
			error = 'folder must be an absolute path';
			return;
		}
		error = '';
		save(LAST_CWD, dir);
		// The dialog stays, with what was typed, until the create succeeds, so
		// that a failure such as a folder that does not exist can be corrected
		// and retried.
		waiting = true;
		const mine = ++attempt;
		void oncreate(dir, cmd, name.trim()).then((ok) => {
			if (mine !== attempt) return;
			waiting = false;
			if (ok) return onclose();
			error = 'the session could not be created';
			folder.focus();
		});
	}
</script>

<dialog bind:this={dialog} aria-labelledby="new-session-title" onkeydown={key} oncancel={cancel}>
	<form onsubmit={submit}>
		<h2 id="new-session-title">New session</h2>
		<div class="field">
			<span class="caption">Folder</span>
			<div class="folder">
				{#if repos.length > 0}
					<select aria-label="Repo" value={repo} onchange={(e) => (cwd = e.currentTarget.value)}>
						<option value="">Repo…</option>
						{#each repos as r (r)}
							<option value={r}>{repoName(r)}</option>
						{/each}
					</select>
				{/if}
				<input
					aria-label="Folder"
					bind:this={folder}
					bind:value={cwd}
					placeholder="home folder"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
				/>
			</div>
			{#if error}<small role="alert">{error}</small>{/if}
		</div>
		<fieldset>
			<legend class="caption">Kind</legend>
			<div class="segments">
				{#each kinds as k (k.cmd)}
					<label>
						<input type="radio" name="kind" value={k.cmd} bind:group={cmd} />
						<Icon name={agentIcon(k.kind)} />
						{k.label}
					</label>
				{/each}
			</div>
		</fieldset>
		<div class="field">
			<span class="caption">Name</span>
			<input aria-label="Name" bind:value={name} placeholder="optional" autocomplete="off" spellcheck="false" />
		</div>
		<div class="buttons">
			<button type="button" onclick={() => onclose()}>Cancel</button>
			<button type="submit" class="primary" disabled={disabled || waiting}>{waiting ? 'Creating…' : 'Create'}</button>
		</div>
	</form>
</dialog>

<style>
	/* The native controls are drawn dark too. */
	dialog {
		box-sizing: border-box;
		width: 380px;
		max-width: calc(100vw - 32px);
		padding: 16px;
		border: 1px solid #333;
		border-radius: 8px;
		background: #252526;
		color: #d4d4d4;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
		color-scheme: dark;
		-webkit-user-select: none;
		user-select: none;
	}
	input {
		-webkit-user-select: text;
		user-select: text;
	}
	dialog::backdrop {
		background: rgba(0, 0, 0, 0.5);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 0;
	}
	h2 {
		margin: 0 0 4px;
		font-size: 13px;
		font-weight: 600;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.caption {
		padding: 0;
		font-size: 11px;
		color: #999;
	}
	.folder {
		display: flex;
		gap: 6px;
	}
	input:not([type='radio']),
	select {
		box-sizing: border-box;
		height: 26px;
		padding: 0 6px;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
		outline: none;
		background: #1e1e1e;
		color: inherit;
		font: inherit;
	}
	.folder input {
		flex: 1;
		min-width: 0;
	}
	select {
		flex: 0 0 112px;
		min-width: 0;
	}
	input:not([type='radio']):focus,
	select:focus {
		border-color: #4fc1ff;
	}
	small {
		color: #f48771;
		font-size: 11px;
	}
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: none;
	}
	legend {
		margin-bottom: 4px;
	}
	/* As a macOS segmented control: the choice is a raised neutral segment,
	   leaving blue to Create and the focus. */
	.segments {
		display: flex;
		gap: 2px;
		padding: 2px;
		border: 1px solid #3c3c3c;
		border-radius: 6px;
		background: #1e1e1e;
		overflow: hidden;
	}
	/* The radio stays focusable for the arrow keys; its label shows the focus. */
	.segments label {
		position: relative;
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 22px;
		border-radius: 4px;
		color: #999;
		cursor: pointer;
	}
	.segments label:hover {
		color: #d4d4d4;
	}
	.segments label:has(input:checked) {
		background: #3c3c3f;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
		color: #fff;
	}
	.segments label:has(input:focus-visible) {
		outline: 1px solid #4fc1ff;
		outline-offset: -1px;
	}
	.segments input {
		position: absolute;
		width: 0;
		height: 0;
		margin: 0;
		opacity: 0;
		pointer-events: none;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}
	button {
		height: 26px;
		padding: 0 14px;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
		background: #3a3d41;
		color: #d4d4d4;
		font: inherit;
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		background: #45494e;
	}
	button.primary {
		border-color: #0e639c;
		background: #0e639c;
		color: #fff;
	}
	button.primary:hover:not(:disabled) {
		background: #1177bb;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:focus-visible {
		outline: 1px solid #4fc1ff;
		outline-offset: 1px;
	}
</style>
