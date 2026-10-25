<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		version,
		installing,
		error,
		oninstall,
		ondismiss,
		onnotes,
	}: {
		version: string;
		installing: boolean;
		error?: string;
		oninstall: () => void;
		ondismiss: () => void;
		onnotes: () => void;
	} = $props();

	const text = $derived(
		installing
			? `Updating to ${version}…`
			: error !== undefined
				? `Update to ${version} failed: ${error}`
				: `vaquita ${version} is available.`,
	);
</script>

<div class="notice" role="status">
	<div class="head">
		<div class="body">
			<span class="text">{text}</span>
			<!-- What a restart does not take: the sessions live in the daemon. -->
			{#if error === undefined}<span class="sub">It relaunches; your sessions keep running.</span>{/if}
		</div>
		<button class="icon-btn" title="Not now" aria-label="Not now" disabled={installing} onclick={ondismiss}>
			<Icon name="x-mark" />
		</button>
	</div>
	<div class="actions">
		<button disabled={installing} onclick={onnotes}>What's new</button>
		<button class="primary" disabled={installing} onclick={oninstall}>{error !== undefined ? 'Retry' : 'Update'}</button>
	</div>
</div>
