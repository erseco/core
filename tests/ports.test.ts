/**
 * Every terminal spelling resolves exactly as it did in 0.8.
 *
 * The fixture was recorded from the 0.8.0 build: for each kind and variant, the
 * names the parser accepted, the canonical terminal each one addresses, and
 * where that terminal sits, rounded to the milli-unit 1.0 draws on. A name not
 * listed was rejected. Two entries differ on purpose: 0.8 resolved reset.out1 to
 * the reset's input, and 1.0 resolves it to the output; and a qgate carrying a
 * parameter is sized to its text's measured width, which is narrower than 0.8's
 * estimate, so its two terminals sit closer in.
 */
import { describe, expect, test } from 'vitest';

import { canonicalPortName, enumerateComponentPorts, parseSchematic, resolvePortGeometry } from '../src/index.js';
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

	test('the parser rejects a name the registry rejects, and says how', () => {
		expect(() => parseSchematic('resistor:R "r" at (500, 500) #amber\nport:P "p" at (100, 100) #amber\nR.gate -> P.in #amber [ortho]', fence)).toThrow(
			'Line 3: Port R.gate is invalid for resistor.'
		);
	});
});
