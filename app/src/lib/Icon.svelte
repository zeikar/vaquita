<script lang="ts">
	import { icons, type IconName } from './icons';

	let { name }: { name: IconName } = $props();

	const icon = $derived(icons[name]);
</script>

<!-- Stroke attributes as Heroicons' outline set ships them. -->
<svg
	aria-hidden="true"
	focusable="false"
	data-icon={name}
	width="14"
	height="14"
	viewBox={icon.viewBox}
	fill={icon.stroke ? 'none' : 'currentColor'}
	stroke={icon.stroke ? 'currentColor' : undefined}
	stroke-width={icon.stroke ? '1.5' : undefined}
	stroke-linecap={icon.stroke ? 'round' : undefined}
	stroke-linejoin={icon.stroke ? 'round' : undefined}
>
	<path d={icon.d} fill-rule={icon.evenodd ? 'evenodd' : undefined} />
</svg>
