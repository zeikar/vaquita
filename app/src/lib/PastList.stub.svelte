<!-- PastList for FilesPanel's tests: keeps what it was last mounted with, and
     lists nothing; refresh and busy are the test's. -->
<script module lang="ts">
	import { vi } from 'vitest';
	import type { SessionInfo } from './protocol';

	type Props = {
		root: string;
		sessions: SessionInfo[];
		repos: string[];
		disabled: boolean;
		onresume: (cwd: string, cmd: string) => void;
		onselect: (sid: number) => void;
		onreopen: (sid: number) => void;
		onleave?: () => void;
		limit?: number;
		report: (message: string) => void;
	};

	export const pastStub: { props?: Props; refresh: ReturnType<typeof vi.fn<() => Promise<void>>> } = {
		refresh: vi.fn(async () => {}),
	};
	export const pastBusy = $state({ busy: false });
</script>

<script lang="ts">
	let props: Props = $props();
	// The live props object, so a test sees them as they are now.
	$effect.pre(() => {
		pastStub.props = props;
	});

	export function refresh(): Promise<void> {
		return pastStub.refresh();
	}

	export function isBusy(): boolean {
		return pastBusy.busy;
	}
</script>

<div class="past-stub" data-root={props.root} data-disabled={props.disabled}></div>
