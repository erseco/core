/**
 * `diagnoseSchematic`: every problem in a document at once, each with where it is.
 *
 * `parseSchematic` stops at the first problem, which is right for a compiler and
 * wrong for an editor. These pin what makes the list trustworthy: problems in
 * separate declarations are all reported, in source order, with the column
 * range of the token at fault; a declaration that fails does not cascade into
 * the lines that use it; and later phases run only on a document whose
 * declarations are sound.
 */
import { describe, expect, test } from 'vitest';

import { diagnoseSchematic, parseSchematic, SCHEMATIC_DIAGNOSTIC_CODES } from '../src/index.js';

const fence = { bounds: { width: 600, height: 400 }, title: 'diagnostics' } as const;
const doc = (...lines: string[]) => lines.join('\n');

describe('collecting', () => {
	test('reports every broken declaration, each at its token', () => {
		const diagnostics = diagnoseSchematic(
			doc(
				'resistor:R1 "a" at (100, 100) #amber',
				'bogus line here',
				'widget:W1 "w" at (200, 100) #amber',
				'resistor:R2 "b" at (300, 100) #amber',
				'R1.out -> R2.in #amber [ortho]',
				'R1.out -> R3.in #amber [ortho]',
				'  R1.nope -> R2.in #amber'
			),
			fence
		);
		expect(diagnostics).toEqual([
			{ code: 'syntax', message: 'Unrecognized schematic declaration.', line: 2, column: 1, endColumn: 16, severity: 'error' },
			{ code: 'reference', message: 'Unsupported component kind widget.', line: 3, column: 1, endColumn: 7, severity: 'error' },
			{ code: 'reference', message: 'Unknown component R3.', line: 6, column: 11, endColumn: 13, severity: 'error' },
			{ code: 'reference', message: 'Port R1.nope is invalid for resistor.', line: 7, column: 6, endColumn: 10, severity: 'error' }
		]);
		for (const diagnostic of diagnostics) expect(SCHEMATIC_DIAGNOSTIC_CODES).toContain(diagnostic.code);
	});

	test('returns nothing for a document that compiles', () => {
		const source = doc('resistor:R1 "a" at (100, 100) #amber', 'resistor:R2 "b" at (300, 100) #amber', 'R1.out -> R2.in #amber [ortho]');
		expect(diagnoseSchematic(source, fence)).toEqual([]);
		expect(() => parseSchematic(source, fence)).not.toThrow();
	});

	test('names a document with no components', () => {
		expect(diagnoseSchematic('// nothing yet', fence)).toEqual([
			{ code: 'syntax', message: 'A schematic must declare at least one component.', severity: 'error' }
		]);
	});

	test('reports a duplicate at the repeated identifier', () => {
		expect(diagnoseSchematic(doc('resistor:R1 "a" at (100, 100) #amber', 'resistor:R1 "b" at (300, 100) #amber'), fence)).toEqual([
			{ code: 'reference', message: 'Duplicate component ID R1.', line: 2, column: 10, endColumn: 12, severity: 'error' }
		]);
	});
});

describe('containment', () => {
	test('a component that fails is not blamed again by the wires that use it', () => {
		const diagnostics = diagnoseSchematic(
			doc(
				'resistor:R1 "a" at (100, 100) #amber [orientation=sideways]',
				'resistor:R2 "b" at (300, 100) #amber',
				'R1.out -> R2.in #amber',
				'R2.out -> R1.in #amber'
			),
			fence
		);
		expect(diagnostics).toEqual([
			{
				code: 'option',
				message: 'Option orientation must be one of: right, down, left, up.',
				line: 1,
				column: 31,
				endColumn: 60,
				severity: 'error'
			}
		]);
	});

	test('topology problems stop the analysis before geometry', () => {
		const diagnostics = diagnoseSchematic(
			doc(
				'resistor:R1 "a" at (100, 100) #amber',
				'resistor:R2 "b" at (100, 100) #amber',
				'R1.out -> R2.in #amber [net=A]',
				'R1.out -> R2.out #amber [net=B]'
			),
			fence
		);
		/* R2 overlaps R1 too, but that is never reached. */
		expect(diagnostics).toEqual([{ code: 'topology', message: 'Terminal joins conflicting nets A and B.', line: 4, severity: 'error' }]);
		expect(diagnoseSchematic(doc('resistor:R1 "a" at (100, 100) #amber', 'resistor:R2 "b" at (300, 100) #amber', 'R1.out -> R2.in #amber [ortho trunk]'), fence)).toMatchObject([
			{ code: 'topology', line: 3 }
		]);
	});

	test('a sound document reports its geometry and routing problems', () => {
		expect(diagnoseSchematic(doc('resistor:R1 "a" at (100, 100) #amber', 'resistor:R2 "b" at (100, 100) #amber'), fence)).toEqual([
			{ code: 'geometry', message: 'R2 overlaps R1 by 84 units horizontally; move R2 to x >= 184, or use a UML container.', line: 2, severity: 'error' }
		]);
		expect(
			diagnoseSchematic(
				doc(
					'port:A "A" at (60,300) #blue',
					'port:B "B" at (150,300) #blue',
					'port:X "X" at (60,120) #blue',
					'port:Y "Y" at (500,340) #blue',
					'A.out -> Y.in #blue [ortho]',
					'B.in -> X.in #blue [ortho]'
				),
				fence
			)
		).toMatchObject([{ code: 'routing', line: 6, message: expect.stringContaining('A.out and B.in sit too close') }]);
	});
});

describe('ordering and spans', () => {
	test('lists problems in source order, whatever phase found them', () => {
		const diagnostics = diagnoseSchematic(doc('resistor:R1 "a" right-of R9 #amber', 'resistor:R2 "b" at (900, 100) #amber'), fence);
		expect(diagnostics.map((diagnostic) => [diagnostic.line, diagnostic.code])).toEqual([
			[1, 'placement'],
			[2, 'geometry']
		]);
	});

	test('a line rewritten by a subcircuit parameter carries no column', () => {
		const diagnostics = diagnoseSchematic(
			doc(
				'subcircuit S [c="amber"] {',
				'  resistor:R "r" at (0, 0) #{{c}} [bogus=1]',
				'  resistor:Q "q" at (0, 60) #amber [bogus=2]',
				'}',
				'S:U at (100, 100)'
			),
			fence
		);
		/* Line 2 was substituted, so its columns would point at the wrong text;
		   line 3 was not, so its span is exact in the definition. */
		expect(diagnostics).toEqual([
			{ code: 'option', message: 'Option bogus is not supported.', line: 2, severity: 'error' },
			{ code: 'option', message: 'Option bogus is not supported.', line: 3, column: 29, endColumn: 45, severity: 'error' }
		]);
	});

	test('reports a broken subcircuit structure once', () => {
		expect(diagnoseSchematic(doc('subcircuit X {', 'resistor:R "r" at (0,0) #amber', '}'), fence)).toEqual([
			{ code: 'syntax', message: 'Subcircuit X is declared but never placed; add X:ID at (x, y), or remove it.', line: 1, severity: 'error' }
		]);
	});
});

describe('placement', () => {
	test('every broken relation is reported once, at its reference, and nothing placed against it is blamed', () => {
		const diagnostics = diagnoseSchematic(
			doc(
				'resistor:R1 "a" right-of X1 #amber',
				'resistor:R2 "b" right-of R1 #amber',
				'resistor:R3 "c" at (100, 100) #amber',
				'port:A "a" right-of B #blue',
				'port:B "b" right-of A #blue',
				'port:C "c" below A #blue',
				'port:D "d" right-of E #blue',
				'port:E "e" right-of D #blue',
				'port:F "f" right-of R3.nope #blue'
			),
			fence
		);
		expect(diagnostics.map(({ line, column, endColumn, message }) => [line, column, endColumn, message.split('.')[0]])).toEqual([
			[1, 26, 28, 'R1 is placed relative to X1, which the document never declares'],
			[4, 21, 22, 'Placement cycle: A -> B -> A'],
			[7, 21, 22, 'Placement cycle: D -> E -> D'],
			[9, 21, 28, 'R3 has no terminal named nope, so F cannot be placed against it']
		]);
		expect(diagnostics.every((diagnostic) => diagnostic.code === 'placement')).toBe(true);
	});

	test('a part placed against a declaration that failed is not told it was never declared', () => {
		/* R1 is declared; its own option failed. D1 is placed right-of R1 and used
		   to be blamed for referencing a part "the document never declares". */
		const diagnostics = diagnoseSchematic(
			doc(
				'source:VIN "v" at (90, 160) #blue [type=voltage-dc]',
				'resistor:R1 "r" right-of VIN by 140 #amber [tolerance=1%]',
				'capacitor:C1 "c" below R2 by 80 #cyan [orientation=down]',
				'diode:D1 "d" right-of R1 by 140 #rose [type=led]'
			),
			fence
		);
		expect(diagnostics.map(({ line, code }) => [line, code])).toEqual([
			[2, 'option'],
			[3, 'placement']
		]);
		expect(diagnostics[1]!.message).toContain('relative to R2, which the document never declares');
	});

	test('a declaration stuck behind a cycle reports the cycle once, for every member', () => {
		const diagnostics = diagnoseSchematic(doc('port:G "g" right-of H #blue', 'port:H "h" right-of I #blue', 'port:I "i" right-of H #blue'), fence);
		expect(diagnostics.map(({ line, message }) => [line, message.split('.')[0]])).toEqual([[1, 'Placement cycle: H -> I -> H']]);
	});

	test('a chain past the depth budget is reported, and what hangs from it is not', () => {
		const diagnostics = diagnoseSchematic(
			doc('resistor:R1 "a" at (100, 100) #amber', 'resistor:R2 "b" below R1 #amber', 'resistor:R3 "c" below R2 #amber', 'resistor:R4 "d" right-of R3 #amber'),
			{ ...fence, limits: { placementDepth: 1 } }
		);
		expect(diagnostics).toMatchObject([{ code: 'placement', line: 3, message: expect.stringContaining('R3 sits 2 placements deep') }]);
	});
});

describe('connection options', () => {
	test('a bus width must be a whole number of bits from 1 through 256', () => {
		const base = 'port:A "A" at (100,100) #blue [width=8]\nport:B "B" at (400,100) #blue [width=8]\nA.out -> B.in #blue [ortho width=WIDTH]';
		for (const width of ['0', '257', '8.5', 'x']) {
			expect(diagnoseSchematic(base.replace('WIDTH', width), fence)).toMatchObject([
				{ code: 'option', line: 3, message: expect.stringContaining('width must be an integer from 1 through 256.') }
			]);
		}
		expect(diagnoseSchematic(base.replace('WIDTH', '8'), fence)).toEqual([]);
	});
});

describe('arguments', () => {
	test('throws for arguments that are not a document at all', () => {
		expect(() => diagnoseSchematic(42 as never, fence)).toThrow('Schematic source must be a string.');
		expect(() => diagnoseSchematic('x', { bounds: { width: -1, height: 2 }, title: 't' })).toThrow(/bounds must be integers/);
	});
});
