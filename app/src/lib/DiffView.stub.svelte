<!-- DiffView for FilePane's tests: records each mount's props and whether it
     was destroyed, with no Monaco and no read. -->
<script module lang="ts">
	export type Stub = {
		props: { repo?: string; path: string; sideBySide: boolean };
		destroyed: boolean;
		focuses: number;
		relayouts: number;
	};
	export const stubs: Stub[] = [];
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';

	let props: { repo?: string; path: string; sideBySide: boolean; report: (message: string) => void } = $props();

	const stub: Stub = {
		get props() {
			return props;
		},
		destroyed: false,
		focuses: 0,
		relayouts: 0,
	};
	stubs.push(stub);
	onDestroy(() => (stub.destroyed = true));

	export function focus(): boolean {
		stub.focuses++;
		return true;
	}

	export function relayout(): void {
		stub.relayouts++;
	}
</script>
