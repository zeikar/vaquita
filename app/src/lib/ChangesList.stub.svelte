<!-- ChangesList for FilesPanel's tests: shows what it was mounted with, and
     lists and watches nothing; its button opens a fixed file. -->
<script lang="ts">
	let {
		root,
		highlight,
		onopen,
	}: { root: string; highlight?: string; onopen: (path: string, pin?: boolean) => void; report: (message: string) => void } = $props();
</script>

<div class="changes-stub" data-root={root} data-highlight={highlight}>
	<button onclick={() => onopen(`${root}/a.ts`)}>open</button>
</div>
