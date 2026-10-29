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

	it('outlines a stroke icon and fills the others', () => {
		const target = document.createElement('div');
		document.body.append(target);
		const outline = mount(Icon, { target, props: { name: 'folder' } });
		const svg = target.querySelector('svg')!;
		expect(svg.getAttribute('fill')).toBe('none');
		expect(svg.getAttribute('stroke')).toBe('currentColor');
		expect(svg.getAttribute('stroke-width')).toBe('1.5');
		expect(svg.getAttribute('stroke-linecap')).toBe('round');
		expect(svg.getAttribute('stroke-linejoin')).toBe('round');
		unmount(outline);
		const filled = mount(Icon, { target, props: { name: 'plus' } });
		expect(target.querySelector('svg')!.getAttribute('fill')).toBe('currentColor');
		expect(target.querySelector('svg')!.hasAttribute('stroke')).toBe(false);
		unmount(filled);
		target.remove();
	});
});
