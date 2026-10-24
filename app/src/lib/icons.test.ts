// @vitest-environment happy-dom
import { mount, unmount } from 'svelte';
import { describe, expect, it } from 'vitest';
import Icon from './Icon.svelte';
import { icons, type IconName } from './icons';

describe('Icon', () => {
	for (const name of Object.keys(icons) as IconName[]) {
		it(`draws ${name} as one hidden svg with path data`, () => {
			const target = document.createElement('div');
			document.body.append(target);
			const c = mount(Icon, { target, props: { name } });
			expect(target.querySelectorAll('svg[aria-hidden]')).toHaveLength(1);
			const paths = [...target.querySelectorAll('svg path')];
			expect(paths.length).toBeGreaterThan(0);
			for (const p of paths) expect(p.getAttribute('d')).not.toBe('');
			unmount(c);
			target.remove();
		});
	}
});
