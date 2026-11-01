<script lang="ts">
	import Icon from './Icon.svelte';
	import appIcon from '../assets/app-icon-256.png';

	let {
		version,
		addDisabled,
		onaddrepo,
		onnewsession,
	}: {
		version?: string;
		addDisabled: boolean;
		onaddrepo: () => void;
		onnewsession: () => void;
	} = $props();

	let root: HTMLDivElement;

	// Takes the focus from any terminal underneath, so that typing never
	// reaches one the user cannot see.
	export function focus(): void {
		root.focus();
	}
</script>

<div class="hello" tabindex="-1" bind:this={root}>
	<div class="col">
		<img class="mark" src={appIcon} alt="" />
		<h1>vaquita</h1>
		<p class="lede">Claude Code and Codex, side by side on your Mac. Sessions keep running when the app quits.</p>
		<div class="acts">
			<button type="button" class="act primary" disabled={addDisabled} onclick={onaddrepo}>
				<Icon name="folder" /><span>Add a repo</span>
			</button>
			<button type="button" class="act" onclick={onnewsession}>
				<Icon name="command-line" /><span>New session</span><kbd>⌘T</kbd>
			</button>
		</div>
		<p class="foot">Or drop a folder on the sidebar.</p>
	</div>
	{#if version}
		<div class="ver">{version}</div>
	{/if}
</div>

<style>
	/* One thing glows; everything else stays in the app's quiet grey. */
	.hello {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
		overflow: hidden;
		background: #1e1e1e;
		outline: none;
	}

	.hello::before {
		content: '';
		position: absolute;
		left: 50%;
		top: 44%;
		width: 620px;
		height: 420px;
		transform: translate(-50%, -50%);
		background: radial-gradient(closest-side, rgba(108, 212, 244, 0.13), rgba(108, 212, 244, 0.04) 55%, transparent);
		pointer-events: none;
	}

	.col {
		position: relative;
		width: 420px;
	}

	.mark {
		display: block;
		width: 112px;
		height: 112px;
		border-radius: 25px;
		filter: drop-shadow(0 0 22px rgba(108, 212, 244, 0.35)) drop-shadow(0 10px 30px rgba(0, 0, 0, 0.6));
	}

	h1 {
		margin: 22px 0 0;
		font: 800 56px/1 -apple-system, 'SF Pro Display', system-ui, sans-serif;
		letter-spacing: -0.035em;
		color: #ececec;
	}

	.lede {
		margin: 10px 0 0;
		max-width: 34ch;
		font-size: 15px;
		line-height: 1.5;
		color: #a8a8a8;
	}

	.acts {
		margin-top: 28px;
		border-top: 1px solid #323233;
	}

	.act {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		height: 44px;
		margin: 0;
		padding: 0;
		border: 0;
		border-bottom: 1px solid #323233;
		background: transparent;
		color: #ddd;
		font: inherit;
		font-size: 14px;
		text-align: left;
	}

	.act:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.03);
	}

	.act:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}

	.act:disabled {
		opacity: 0.5;
	}

	.act :global(svg) {
		flex: none;
		width: 18px;
		height: 18px;
		color: var(--neon);
	}

	.act span {
		flex: 1;
	}

	.act.primary span {
		color: #fff;
		font-weight: 600;
	}

	kbd {
		padding: 1px 6px;
		border: 1px solid #3a3a3c;
		border-radius: 4px;
		font: 12px -apple-system, system-ui, sans-serif;
		color: #8b8b8b;
	}

	.foot {
		margin: 16px 0 0;
		font-size: 12px;
		color: #777;
	}

	.ver {
		position: absolute;
		right: 16px;
		bottom: 12px;
		font-size: 11px;
		color: #5e5e5e;
	}
</style>
