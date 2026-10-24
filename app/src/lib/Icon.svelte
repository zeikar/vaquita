<script lang="ts">
	import { icons, type IconName } from './icons';

	let { name }: { name: IconName } = $props();

	const icon = $derived(icons[name]);
</script>

<svg aria-hidden="true" focusable="false" data-icon={name} width="14" height="14" viewBox={icon.viewBox} fill="currentColor">
	<path d={icon.d} fill-rule={icon.evenodd ? 'evenodd' : undefined} />
</svg>
