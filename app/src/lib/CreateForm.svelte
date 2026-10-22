<script lang="ts">
	import { load, save } from './storage';

	const CWD_KEY = 'vaquita.cwd';

	let {
		disabled,
		oncreate,
	}: {
		disabled: boolean;
		oncreate: (cwd: string, cmd: string, name: string) => void;
	} = $props();

	let cwd = $state(load(CWD_KEY) ?? '');
	let cmd = $state('');
	let name = $state('');
	let error = $state('');

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const dir = cwd.trim();
		// The daemon neither expands ~ nor anchors a relative path.
		if (dir !== '' && !dir.startsWith('/')) {
			error = 'cwd must be an absolute path';
			return;
		}
		error = '';
		save(CWD_KEY, dir);
		oncreate(dir, cmd.trim(), name.trim());
	}
</script>

<form onsubmit={submit}>
	<input bind:value={cwd} placeholder="cwd (default: home)" />
	<input bind:value={cmd} placeholder="command (optional)" />
	<input bind:value={name} placeholder="name (optional)" />
	{#if error}<small role="alert">{error}</small>{/if}
	<button type="submit" {disabled}>Create</button>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border-top: 1px solid #333;
	}
</style>
