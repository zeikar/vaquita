<!-- FileTree for FilesPanel's tests: shows what it was mounted with, and
     reads and watches nothing. -->
<script lang="ts">
	let { root, highlight }: { root: string; highlight?: string; onopen: (path: string, pin?: boolean) => void; report: (message: string) => void } =
		$props();
</script>

<div class="tree-stub" data-root={root} data-highlight={highlight}></div>
