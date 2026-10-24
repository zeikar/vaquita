<script lang="ts">
	import { icons, type IconName } from './icons';

	let { name, size = 14 }: { name: IconName; size?: number } = $props();

	const icon = $derived(icons[name]);
	const paths = $derived(Array.isArray(icon.d) ? icon.d : [icon.d]);
</script>

<svg
	aria-hidden="true"
	focusable="false"
	data-icon={name}
	width={size}
	height={size}
	viewBox={icon.viewBox}
	fill="currentColor"
>
	{#each paths as d}
		<path {d} fill-rule={icon.evenodd ? 'evenodd' : undefined} />
	{/each}
</svg>
