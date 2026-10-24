/**
 * Every terminal spelling resolves exactly as it did in 0.8.
 *
 * The fixture was recorded from the 0.8.0 build: for each kind and variant, the
 * names the parser accepted, the canonical terminal each one addresses, and
 * where that terminal sits, rounded to the milli-unit 1.0 draws on. A name not
 * listed was rejected. Some entries differ on purpose:
 *
 * - 0.8 resolved reset.out1 to the reset's input; 1.0 resolves it to the output.
 * - A qgate carrying a parameter is sized to its text's measured width, which is
 *   narrower than 0.8's estimate, so its two terminals sit closer in.
 * - 0.8 drew distinct terminals of digital blocks at one point — a flip-flop's
 *   j and k, q and nq, preset and clear; a mux's select and enable; a register's
 *   or counter's clock and enable; a comparator's gt, eq and lt. Each now has a
 *   slot of its own. A flip-flop accepts only its own variant's letters, where
 *   0.8 drew any of them on its first input, and a register lists the in2, in3
 *   and out2 terminals 0.8 drew and accepted but did not enumerate.
 * - 1.1: a multi-track gate's vertical terminal on its lowest rail faces down.
 *   0.8 and 1.0 pointed every one up, so a wire to the lowest one ran through
 *   each terminal above it.
 */
import { describe, expect, test } from 'vitest';

import { canonicalPortName, compileSchematic, enumerateComponentPorts, parseSchematic, resolvePortGeometry } from '../src/index.js';
import { canonicalName } from '../src/symbols/index.js';
import recorded from './fixtures/port-resolution-0.8.json';

type Row = string | { ports: string[]; valid: Record<string, [string, number, number, number, number]> };
const fixture = recorded as unknown as Record<string, Row>;
const names = ['in', 'out', 'in1', 'in2', 'in3', 'in4', 'in5', 'out1', 'out2', 'out3', 'out5', 'in0', 'out0', 'a', 'b', 'c', 'y', 'left', 'right', 'top', 'bottom', 'l', 'r', 't', 'positive', 'negative', 'plus', 'minus', 'gate', 'drain', 'source', 'base', 'collector', 'emitter', 'anode', 'cathode', 'node', 'select', 'select1', 'enable', 'clk', 'clock', 'd', 'q', 'qbar', 'j', 'k', 's', 'gt', 'eq', 'lt', 'bus', 'tap', 'tap1', 'tap4', 'control', 'control1', 'control2', 'target', 'target1', 'target2', 'common', 'nc', 'no', 'coil1', 'coil2', 'wiper', 'primary1', 'secondary1', 'p1', 'p2', 's1', 's2', 'cin', 'cout', 'sum', 'carry', 'reset', 'load', 'up', 'down', 'center', 'lifeline', 'head', 'tail', 'A', 'B', 'Y', 'pin1', 'x', 'X+', 'in-', 'in+', 'vcc', 'gnd', 'v+', 'v-', 'output', 'input'];
const fence = { bounds: { width: 1000, height: 1000 }, title: 'ports' } as const;

describe('port resolution parity with 0.8', () => {
	test.each(Object.entries(fixture))('%s', (declaration, row) => {
		if (typeof row === 'string') {
			expect(() => parseSchematic(declaration, fence)).toThrow(row.slice('PARSE '.length));
			return;
		}
		const component = parseSchematic(declaration, fence).components[0]!;
		expect(enumerateComponentPorts(component).map((port) => port.id)).toEqual(row.ports);
		for (const name of names) {
			const expected = row.valid[name];
			if (expected === undefined) {
				expect(canonicalName(component, name), name).toBeUndefined();
				continue;
			}
			const geometry = resolvePortGeometry(component, name);
			expect([canonicalPortName(component, name), geometry.point.x, geometry.point.y, geometry.normal.x, geometry.normal.y], name).toEqual(expected);
		}
	});

	test('no two distinct terminals of any kind share a point', () => {
		for (const declaration of Object.keys(fixture)) {
			if (typeof fixture[declaration] === 'string') continue;
			const component = parseSchematic(declaration, fence).components[0]!;
			const points = enumerateComponentPorts(component).map((port) => `${port.point.x},${port.point.y}`);
			expect(new Set(points).size, declaration).toBe(points.length);
		}
	});

	test('every terminal of a digital block has a lead drawn to it', () => {
		const source = 'register:R "r" at (500, 500) #amber\nflipflop:F "f" at (300, 500) #amber [type=jk]';
		const document = parseSchematic(source, fence);
		const svg = compileSchematic(source, { ...fence, mode: 'full' }).svg;
		for (const component of document.components) {
			for (const port of enumerateComponentPorts(component)) {
				/* Leads are drawn in local coordinates, starting at the terminal. */
				const milli = (value: number) => Math.round(value * 1000) / 1000;
				const local = `M ${milli(port.point.x - component.x)} ${milli(port.point.y - component.y)} `;
				expect(svg, `${component.id}.${port.id}`).toContain(local);
			}
		}
	});

	test("a tristate buffer's enable lead reaches its terminal", () => {
		const source = 'buffer:T "t" at (700, 500) #amber [type=tristate]';
		const [component] = parseSchematic(source, fence).components;
		const enable = enumerateComponentPorts(component!).find((port) => port.id === 'enable')!;
		expect([enable.point.x - component!.x, enable.point.y - component!.y]).toEqual([0, 42]);
		expect(compileSchematic(source, { ...fence, mode: 'full' }).svg).toContain('d="M 0 42 V 12"');
	});

	test('the parser rejects a name the registry rejects, and says how', () => {
		expect(() => parseSchematic('resistor:R "r" at (500, 500) #amber\nport:P "p" at (100, 100) #amber\nR.gate -> P.in #amber [ortho]', fence)).toThrow(
			'Line 3: Port R.gate is invalid for resistor.'
		);
	});
});
