<script lang="ts">
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

	async function choose() {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const dir = await open({ directory: true, multiple: false, title: 'Add repo' });
			if (dir !== null) {
				path = dir;
				error = '';
			}
		} catch (e) {
			error = `folder picker failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const dir = path.trim();
		// The daemon neither expands ~ nor anchors a relative path.
		if (!dir.startsWith('/')) {
			error = 'repo path must be an absolute path';
			return;
		}
		error = '';
		onadd(dir);
		path = '';
	}
</script>

<form onsubmit={submit}>
	<input bind:value={path} placeholder="repo path" />
	{#if error}<small role="alert">{error}</small>{/if}
	<div class="buttons">
		{#if isTauri()}<button type="button" onclick={choose}>Choose…</button>{/if}
		<button type="submit" {disabled}>Add</button>
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border-top: 1px solid #333;
	}
	.buttons {
		display: flex;
		gap: 4px;
	}
	.buttons button[type='submit'] {
		flex: 1;
	}
</style>
