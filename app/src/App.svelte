<script lang="ts">
	import { homeDir } from '@tauri-apps/api/path';
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy } from 'svelte';
	import AddRepo from './lib/AddRepo.svelte';
	import AppUpdateBanner from './lib/AppUpdateBanner.svelte';
	import { AppUpdater, releaseUrl } from './lib/app-update';
	import { DaemonConnection } from './lib/connection';
	import { runningCount } from './lib/daemon-update';
	import { appBuild, checkAppUpdate, checkRestart, installAppUpdate, onUpdateCheckAsked, readEndpoint, restartDaemon, startDaemon } from './lib/endpoint';
	import { watchFocus } from './lib/focus';
	import { repoOf } from './lib/groups';
	import Icon from './lib/Icon.svelte';
	import { isNewSessionShortcut } from './lib/keys';
	import { openExternal } from './lib/links';
	import { SessionManager } from './lib/manager';
	import NewSessionDialog, { LAST_CWD } from './lib/NewSessionDialog.svelte';
	import type { Notifier, Target } from './lib/notify';
	import SessionList from './lib/SessionList.svelte';
	import { load } from './lib/storage';
	import TerminalPane from './lib/TerminalPane.svelte';
	import { shellQuoteAll } from './lib/shellquote';
	import { isTauri } from './lib/tauri';
	import { createTauriNotifier } from './lib/tauri-notify';
	import { createTerminal, TermView } from './lib/term-view';
	import UpdateBanner from './lib/UpdateBanner.svelte';

	// Replaced by the Tauri notifier once it is ready; the console one stays in
	// a plain browser and when the Tauri one cannot be set up.
	let notifier: Notifier = { show: (n) => console.info('notification', n) };
	const manager = new SessionManager({
		readEndpoint,
		startDaemon,
		appBuild,
		checkRestart,
		restartDaemon,
		connect: (endpoint, handlers) => new DaemonConnection(endpoint, handlers),
		createTerminal: (cols, rows) => createTerminal(cols, rows),
		createView: (term, core, cwd) => new TermView(term, core, (m) => manager.report(m), cwd),
		notifier: { show: (n) => notifier.show(n) },
	});
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
		manager.stop();
	});
	onDestroy(
		watchFocus(
			(focused) => manager.setFocused(focused),
			(e) => manager.report(`window focus unavailable: ${e instanceof Error ? e.message : String(e)}`),
		),
	);

	// Closed for this app run: the restart can wait, and the notice covers the terminal.
	let daemonNoticeClosed = $state(false);

	const appUpdater = new AppUpdater({
		check: checkAppUpdate,
		install: installAppUpdate,
		warn: (m) => console.warn(m),
		report: (m) => manager.report(m),
	});
	appUpdater.start();
	onDestroy(() => appUpdater.stop());
	const unlistenCheck = onUpdateCheckAsked(() => void appUpdater.checkNow());
	unlistenCheck.catch((e) => manager.report(`Check for Updates unavailable: ${e instanceof Error ? e.message : String(e)}`));
	onDestroy(() => void unlistenCheck.then((f) => f(), () => {}));

	// A click brings the window up whatever the notification was about; the
	// manager selects its session only if that very session is still there.
	function openNotified(target?: Target): void {
		manager.openNotified(target);
		const win = getCurrentWindow();
		win.show()
			.then(() => win.unminimize())
			.then(() => win.setFocus())
			.catch((e) => manager.report(`bringing the window up failed: ${e instanceof Error ? e.message : String(e)}`));
	}

	// The manager starts once the notifier is set up, so the notifications it
	// sends on connecting, such as the missed summary, do not go to the console.
	const tauriNotifier = isTauri()
		? createTauriNotifier(openNotified, (e) => manager.report(`notification failed: ${e instanceof Error ? e.message : String(e)}`))
		: undefined;
	onDestroy(() => void tauriNotifier?.then((n) => n.stop()).catch(() => {}));
	void Promise.resolve(tauriNotifier)
		.then(
			(n) => {
				if (n) notifier = n;
				return n?.allowed === false ? 'notifications are turned off for vaquita in System Settings' : undefined;
			},
			(e) => `notifications unavailable: ${e instanceof Error ? e.message : String(e)}`,
		)
		.then((failure) => {
			if (destroyed) return;
			manager.start();
			// After the start, which clears the status line.
			if (failure) manager.report(failure);
		});

	let aside = $state<HTMLElement>();
	let addRepo = $state<ReturnType<typeof AddRepo>>();

	let dialogOpen = $state(false);
	let dialogCwd = $state('');

	// The dialog starts in the selected session's repo, else in the folder it
	// last created a session in, else in the home folder.
	function newSession() {
		if (dialogOpen) return;
		const { sessions, selected, repos } = $manager;
		const cwd = sessions.find((r) => r.info.sid === selected)?.info.cwd;
		dialogCwd = (cwd !== undefined ? repoOf(cwd, repos) : undefined) ?? load(LAST_CWD) ?? '';
		dialogOpen = true;
	}

	// On the window in the capture phase, so it runs before xterm's handler on
	// its textarea and the terminal never sees the key.
	function shortcut(e: KeyboardEvent) {
		if (!isNewSessionShortcut(e)) return;
		e.preventDefault();
		e.stopPropagation();
		newSession();
	}

	// The OS file drop only exists inside Tauri. Paths dropped on the sidebar
	// are added as repos; anywhere else they are typed into the selected session.
	if (isTauri()) {
		const unlisten = getCurrentWebview().onDragDropEvent((e) => {
			if (e.payload.type !== 'drop') return;
			// The position arrives in physical pixels.
			const { x, y } = e.payload.position.toLogical(window.devicePixelRatio);
			const box = aside?.getBoundingClientRect();
			if (box && x >= box.left && x < box.right && y >= box.top && y < box.bottom) {
				for (const p of e.payload.paths) manager.addRepo(p);
				return;
			}
			const { sessions, selected } = $manager;
			const view = sessions.find((r) => r.info.sid === selected)?.view;
			if (!view) return;
			try {
				view.sendInput(shellQuoteAll(e.payload.paths));
			} catch (err) {
				manager.report(`file drop refused: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		unlisten.catch((e) => manager.report(`file drop unavailable: ${e instanceof Error ? e.message : String(e)}`));
		onDestroy(() => void unlisten.then((f) => f(), () => {}));
	}

	// Rows show paths under it with ~; in a plain browser it stays unknown and
	// paths absolute, as a guess could show another user's folder as home.
	let home = $state<string>();
	if (isTauri()) {
		homeDir().then(
			(h) => (home = h),
			(e) => manager.report(`home folder unavailable: ${e instanceof Error ? e.message : String(e)}`),
		);
	}

	const statusText = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'connected';
			case 'connecting':
				return 'connecting…';
			case 'starting':
				return 'starting daemon…';
			case 'restarting':
				return 'restarting daemon…';
			case 'not-running':
				return 'daemon not running';
			case 'version-mismatch':
				return `daemon restart needed (daemon v${$manager.daemonV}, app v1)`;
			case 'disconnected':
				return 'disconnected, retrying…';
		}
	});
	// The status line is grey; only its dot says how the daemon is.
	const statusTone = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'ok';
			case 'not-running':
			case 'version-mismatch':
				return 'bad';
			default:
				return 'wait';
		}
	});
</script>

<svelte:window onkeydowncapture={shortcut} />

<main>
	<aside bind:this={aside}>
		<header>
			<span class="title">Repos</span>
			<AddRepo bind:this={addRepo} disabled={$manager.status !== 'connected'} onadd={(p) => manager.addRepo(p)} />
		</header>
		<SessionList
			sessions={$manager.sessions}
			selected={$manager.selected}
			onselect={(sid) => manager.select(sid)}
			onkill={(sid) => manager.kill(sid)}
			repos={$manager.repos}
			{home}
			disabled={$manager.creating || $manager.status !== 'connected'}
			onreopen={(sid) => manager.reopen(sid)}
			ondismiss={(sid) => manager.dismiss(sid)}
			onstart={(repo, cmd) => manager.create(repo, cmd, '')}
			onremoverepo={(p) => manager.removeRepo(p)}
			onrename={(sid, name) => manager.rename(sid, name)}
			onreport={(m) => manager.report(m)}
			addDisabled={$manager.status !== 'connected'}
			onaddrepo={() => void addRepo?.open()}
			onnewsession={newSession}
		/>
		<div class="sidebar-footer">
			<button class="new-session" title="New session (⌘T)" onclick={newSession}>
				<Icon name="plus" />
				<span class="label">New session</span>
				<kbd>⌘T</kbd>
			</button>
		</div>
	</aside>
	<NewSessionDialog
		open={dialogOpen}
		repos={$manager.repos}
		defaultCwd={dialogCwd}
		disabled={$manager.creating || $manager.status !== 'connected'}
		oncreate={(cwd, cmd, name) => manager.create(cwd, cmd, name)}
		onclose={() => (dialogOpen = false)}
		fallbackFocus={() => $manager.sessions.find((r) => r.info.sid === $manager.selected)?.view?.focus()}
	/>
	<TerminalPane sessions={$manager.sessions} selected={$manager.selected} />
	<div class="notices">
		{#if $appUpdater.version !== undefined}
			{@const version = $appUpdater.version}
			<AppUpdateBanner
				{version}
				installing={$appUpdater.installing}
				error={$appUpdater.error}
				oninstall={() => appUpdater.install()}
				ondismiss={() => appUpdater.dismiss()}
				onnotes={() => openExternal(releaseUrl(version), (e) => manager.report(`opening the release notes failed: ${e instanceof Error ? e.message : String(e)}`))}
			/>
		{/if}
		{#if $manager.update && $manager.status === 'connected' && !daemonNoticeClosed}
			<UpdateBanner
				update={$manager.update}
				running={runningCount($manager.sessions.map((r) => r.info))}
				onrestart={() => manager.restartDaemon()}
				ondismiss={() => (daemonNoticeClosed = true)}
			/>
		{/if}
	</div>
	<footer>
		<span class="state"><span class="dot {statusTone}"></span>{statusText}</span>
		<span>{$manager.sessions.length} sessions</span>
		{#if $manager.message}<span class="message" title={$manager.message}>{$manager.message}</span>{/if}
	</footer>
</main>
