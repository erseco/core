/**
 * A part may be declared without a label.
 *
 * Every part draws its designator above it and its label below. When the label
 * says nothing the designator does not — a converted circuit's `J1`, a part an
 * author has not named yet — drawing the ID twice is noise. Leaving the quoted
 * label out draws the designator alone: no label row, no label obstacle for the
 * router, nothing in the accessible name, and nothing written back by the
 * decompiler.
 */
import { describe, expect, test } from 'vitest';

import {
	buildNetlist,
	compileSchematic,
	diagnoseSchematic,
	parseSchematic,
	type SchematicFence
} from '../src/index.js';
import { parseSchematicSvg } from '../src/decompile.js';
import { describeSchematic } from '../src/describe.js';
import { labelRects } from '../src/layout.js';

const fence: SchematicFence = { bounds: { width: 640, height: 360 }, title: 'Labels' };

const UNLABELLED = `source:B1 at (80, 180) #blue [type=battery orientation=down]
resistor:R1 "100" at (240, 80) #amber
resistor:R2 right-of R1 by 100 #amber
junction:J1 at (520, 180) #slate

B1.negative -> R1.in #blue [ortho]
R1.out -> R2.in #amber [ortho]
R2.out -> J1.node #amber [ortho]
J1.node -> B1.positive #slate [ortho]`;

const component = (source: string, id: string) => parseSchematic(source, fence).components.find((part) => part.id === id)!;

describe('a declaration without a label', () => {
	test('parses in both the absolute and the relative form, with an empty label', () => {
		const document = parseSchematic(UNLABELLED, fence);
		expect(document.components.map((part) => [part.id, part.label])).toEqual([
			['B1', ''],
			['R1', '100'],
			['R2', ''],
			['J1', '']
		]);
		/* The relative form still resolved its relation. */
		expect(component(UNLABELLED, 'R2').x).toBeGreaterThan(component(UNLABELLED, 'R1').x);
	});

	test('compiles and routes on the first pass', () => {
		expect(diagnoseSchematic(UNLABELLED, fence)).toEqual([]);
		expect(compileSchematic(UNLABELLED, fence).routing.attempts).toBe(0);
	});

	test('reports a problem later on the line at its own column', () => {
		const [problem] = diagnoseSchematic('resistor:R1 at (240, 80) #amber [orientation=sideways]', fence);
		expect(problem).toMatchObject({ code: 'option', line: 1, column: 26, endColumn: 55 });
	});

	test('still rejects an empty quoted label', () => {
		const [problem] = diagnoseSchematic('resistor:R1 "" at (240, 80) #amber', fence);
		expect(problem).toMatchObject({ code: 'syntax', message: 'Unrecognized schematic declaration.' });
	});
});

describe('drawing a part without a label', () => {
	const svg = compileSchematic(UNLABELLED, fence).svg;
	/* One component's group: from its opening tag to the next component's. */
	const group = (id: string) => {
		const start = svg.lastIndexOf('<g class="schematic-component"', svg.indexOf(`>${id}</text>`));
		const end = svg.indexOf('<g class="schematic-component"', start + 1);
		return svg.slice(start, end < 0 ? undefined : end);
	};

	test('draws the designator and no label row', () => {
		expect(group('B1')).toContain('>B1</text>');
		expect(group('B1')).not.toContain('schematic-label');
		expect(group('R1')).toContain('class="schematic-label"');
		/* One labelled part, so exactly one label row in the document. */
		expect(svg.match(/class="schematic-label"/g)).toHaveLength(1);
		expect(svg).toContain('>100</text>');
	});

	test('gives the router no label row to keep clear of', () => {
		expect(labelRects(component(UNLABELLED, 'B1'))).toHaveLength(1);
		expect(labelRects(component(UNLABELLED, 'J1'))).toHaveLength(1);
		expect(labelRects(component(UNLABELLED, 'R1'))).toHaveLength(2);
	});

	test('leaves the label out of the accessible name', () => {
		const full = compileSchematic(UNLABELLED, { ...fence, mode: 'full' }).svg;
		expect(full).toContain('aria-label="B1, source, battery');
		expect(full).not.toContain('aria-label="B1, source, , ');
		expect(full).toContain('aria-label="J1, junction"');
		expect(full).toContain('aria-label="R2, resistor, fixed"');
		expect(full).toContain('aria-label="R1, resistor, 100, fixed"');
	});
});

describe('reading an unlabelled part back', () => {
	test('names it by its ID alone in the netlist and the description', () => {
		const document = parseSchematic(UNLABELLED, fence);
		expect(buildNetlist(document).nodes.find((node) => node.id === 'B1')!.label).toBe('');
		const text = describeSchematic(document).text;
		expect(text).toContain('one source B1, two resistors (R1 (100), R2), and one junction J1.');
	});

	test('decompiles without a label, and recompiles to the same drawing', () => {
		const full = compileSchematic(UNLABELLED, { ...fence, mode: 'full' }).svg;
		const recovered = parseSchematicSvg(full);
		expect(recovered.source.split('\n').slice(0, 4)).toEqual([
			'source:B1 at (80, 180) #blue [orientation=down]',
			'resistor:R1 "100" at (240, 80) #amber',
			'resistor:R2 at (432, 80) #amber',
			'junction:J1 at (520, 180) #slate'
		]);
		expect(parseSchematic(recovered.source, fence).components.map((part) => part.label)).toEqual(['', '100', '', '']);
	});
});
