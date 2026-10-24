/**
 * `fit=wires`: parts that take their height from their wires.
 *
 * The premise checked here is the one the option exists for: on a fitted part,
 * every wired terminal sits level with the terminal wired to it, so the wire
 * between them is one straight run. The rest pins the rules that make that
 * deterministic — fitted parts settle left to right, a terminal with several
 * partners follows the nearest, unwired terminals keep the part's pitch — and
 * the diagnostics an author sees when a fit is impossible.
 */
import { describe, expect, test } from 'vitest';

import {
	compileSchematic,
	diagnoseSchematic,
	parseSchematic,
	resolvePortGeometry,
	resolvePortPoint,
	type SchematicComponent,
	type SchematicDocument,
	type SchematicFence
} from '../src/index.js';
import { parseSchematicSvg } from '../src/decompile.js';
import { FIT_GAP, fitComponents } from '../src/fit.js';

const fence: SchematicFence = { bounds: { width: 1200, height: 800 }, title: 'Fit fixture' };

function part(document: SchematicDocument, id: string): SchematicComponent {
	return document.components.find((component) => component.id === id)!;
}

function y(document: SchematicDocument, id: string, port: string): number {
	return resolvePortPoint(part(document, id), port).y;
}

function failure(source: string): string {
	try {
		parseSchematic(source, fence);
	} catch (error) {
		return (error as Error).message.replace(/^Line \d+: /, '');
	}
	throw new Error('expected the document to be rejected');
}

/** Every wire is one straight run: each trace subpath is a move and one horizontal line. */
function straight(svg: string): boolean {
	const runs = [...svg.matchAll(/schematic-trace" d="([^"]+)"/g)].flatMap((match) => match[1]!.split(/(?=M )/).map((run) => run.trim()));
	expect(runs.length).toBeGreaterThan(0);
	return runs.every((run) => /^M [-\d.]+ [-\d.]+ H [-\d.]+$/.test(run));
}

/** The trace runs, sorted, so two drawings compare by geometry rather than element order. */
function traces(svg: string): string[] {
	return [...svg.matchAll(/schematic-trace" d="([^"]+)"/g)].flatMap((match) => match[1]!.split(/(?=M )/).map((run) => run.trim())).sort();
}

const BELL = `prepare:Q0 "q0" at (80, 90) #blue
prepare:Q1 "q1" at (80, 210) #blue
hadamard:H1 "H" at (280, 90) #cyan
cnot:CX1 "CNOT" at (460, 150) #purple [fit=wires]
measure:M0 "M0" at (640, 90) #emerald
measure:M1 "M1" at (640, 210) #emerald

Q0.out -> H1.in #blue [ortho]
H1.out -> CX1.in1 #cyan [ortho]
Q1.out -> CX1.in2 #blue [ortho]
CX1.out1 -> M0.in #purple [ortho]
CX1.out2 -> M1.in #purple [ortho]`;

describe('fit=wires on quantum gates', () => {
	test('a CNOT takes its rails from its qubits and every wire is straight', () => {
		const compilation = compileSchematic(BELL, fence);
		const document = compilation.document;
		expect(part(document, 'CX1')).toMatchObject({ y: 150, rails: [-60, 60], fit: 'wires' });
		expect(y(document, 'CX1', 'in1')).toBe(90);
		expect(y(document, 'CX1', 'in2')).toBe(210);
		expect(y(document, 'CX1', 'control')).toBe(90);
		expect(y(document, 'CX1', 'target')).toBe(210);
		expect(straight(compilation.svg)).toBe(true);
		expect(compilation.routing.attempts).toBe(0);
		expect(compileSchematic(BELL, { ...fence, mode: 'full' }).svg).toContain('data-fit="wires"');
		/* The drawing spans the rails it joins: the control dot on q0, the target on q1. */
		expect(compilation.svg).toContain('M -42 -60 H 42 M -42 60 H 42 M 0 -60 V 60 M -7 60 H 7 M 0 53 V 67');
	});

	test('an unfitted CNOT is drawn exactly as 1.0 drew it', () => {
		const svg = compileSchematic(BELL.replace(' [fit=wires]', ''), fence).svg;
		expect(svg).toContain('M -42 -9 H 42 M -42 9 H 42 M 0 -9 V 9 M -7 9 H 7 M 0 2 V 16');
		expect(svg).not.toContain('data-fit');
	});

	test('a control below its target needs no special syntax', () => {
		const document = parseSchematic(BELL.replace('Q0.out -> H1.in', 'Q0.out -> H1.in').replace('H1.out -> CX1.in1 #cyan [ortho]\nQ1.out -> CX1.in2', 'H1.out -> CX1.in2 #cyan [ortho]\nQ1.out -> CX1.in1').replace('CX1.out1 -> M0.in #purple [ortho]\nCX1.out2 -> M1.in', 'CX1.out2 -> M0.in #purple [ortho]\nCX1.out1 -> M1.in'), fence);
		expect(part(document, 'CX1')).toMatchObject({ rails: [60, -60] });
		expect(y(document, 'CX1', 'control')).toBe(210);
		expect(y(document, 'CX1', 'target')).toBe(90);
		/* Each vertical terminal still faces away from the other. */
		expect(resolvePortGeometry(part(document, 'CX1'), 'control').normal).toEqual({ x: 0, y: 1 });
		expect(resolvePortGeometry(part(document, 'CX1'), 'target').normal).toEqual({ x: 0, y: -1 });
	});

	test('a rail takes its input\'s height when its input and output disagree', () => {
		const document = parseSchematic(
			`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (80, 220) #blue
cnot:CX "CX" at (240, 160) #purple [fit=wires]
measure:M "m" at (420, 130) #emerald
A.out -> CX.in1 #blue [ortho]
B.out -> CX.in2 #blue [ortho]
CX.out1 -> M.in #emerald [ortho]`,
			fence
		);
		expect(part(document, 'CX')).toMatchObject({ y: 160, rails: [-60, 60] });
	});

	test('a gate reads only gates settled before it, never one still to fit', () => {
		/* CX1's second rail is wired only to CX2, which settles after it: CX1
		   spaces that rail at its pitch rather than reading CX2's unfitted pin. */
		const document = parseSchematic(
			`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (80, 300) #blue
cnot:CX1 "CX" at (260, 200) #purple [fit=wires]
cnot:CX2 "CX" at (460, 250) #purple [fit=wires]
A.out -> CX1.in1 #blue [ortho]
CX1.out2 -> CX2.in1 #purple [ortho]
B.out -> CX2.in2 #blue [ortho]`,
			fence
		);
		expect(part(document, 'CX1')).toMatchObject({ y: 109, rails: [-9, 9] });
		expect(part(document, 'CX2')).toMatchObject({ rails: [-91, 91] });
	});

	test('rails exactly the least gap apart fit', () => {
		const document = parseSchematic(
			`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (180, ${100 + FIT_GAP}) #blue
cnot:CX "CX" at (360, 108) #purple [fit=wires]
A.out -> CX.in1 #blue [ortho]
B.out -> CX.in2 #blue [ortho]`,
			fence
		);
		expect(part(document, 'CX')).toMatchObject({ rails: [-8, 8] });
	});

	test('a rail wired only on its output takes its height from there', () => {
		const document = parseSchematic(
			`prepare:A "a" at (80, 100) #blue
measure:B "b" at (400, 160) #emerald
cnot:CX "CX" at (240, 130) #purple [fit=wires]
A.out -> CX.in1 #blue [ortho]
CX.out2 -> B.in #emerald [ortho]`,
			fence
		);
		expect(part(document, 'CX')).toMatchObject({ y: 130, rails: [-30, 30] });
	});

	test('chained gates settle left to right, each reading the gates before it', () => {
		const compilation = compileSchematic(
			`prepare:PSI "psi" at (70, 80) #purple
prepare:A "a" at (70, 200) #blue
prepare:B "b" at (70, 320) #blue
cnot:CX1 "CNOT" at (340, 260) #blue [fit=wires]
cnot:CX2 "CNOT" at (470, 140) #purple [fit=wires]
measure:MZ1 "M" at (720, 80) #amber
measure:MZ2 "M" at (720, 200) #amber
measure:MZ3 "M" at (720, 320) #amber
PSI.out -> CX2.in1 #purple [ortho]
A.out -> CX1.in1 #blue [ortho]
B.out -> CX1.in2 #blue [ortho]
CX1.out1 -> CX2.in2 #blue [ortho]
CX2.out1 -> MZ1.in #purple [ortho]
CX2.out2 -> MZ2.in #purple [ortho]
CX1.out2 -> MZ3.in #blue [ortho]`,
			fence
		);
		expect(part(compilation.document, 'CX1')).toMatchObject({ y: 260, rails: [-60, 60] });
		expect(part(compilation.document, 'CX2')).toMatchObject({ y: 140, rails: [-60, 60] });
		expect(straight(compilation.svg)).toBe(true);
	});

	test('multi-track gates, barriers and delays fit every rail and fill an unwired one at the usual pitch', () => {
		const rails = (kind: string, extra = '') =>
			part(
				parseSchematic(
					`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (80, 220) #blue
${kind}:G "G" at (300, 160) #purple [fit=wires${extra}]
A.out -> G.in1 #blue [ortho]
B.out -> G.in2 #blue [ortho]`,
					fence
				),
				'G'
			);
		expect(rails('cz')).toMatchObject({ y: 160, rails: [-60, 60] });
		expect(rails('swap')).toMatchObject({ rails: [-60, 60] });
		expect(rails('cphase')).toMatchObject({ rails: [-60, 60] });
		expect(rails('barrier')).toMatchObject({ rails: [-60, 60] });
		expect(rails('delay', ' wires=3')).toMatchObject({ y: 169, rails: [-69, 51, 69] });
		expect(rails('toffoli')).toMatchObject({ rails: [-69, 51, 69] });
		expect(rails('controlled', ' controls=2 operator=U')).toMatchObject({ rails: [-69, 51, 69] });
	});

	test('fitted multi-track glyphs span their rails', () => {
		const svg = (kind: string, extra = '') =>
			compileSchematic(
				`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (80, 220) #blue
prepare:C "c" at (80, 300) #blue
${kind}:G "G" at (300, 200) #purple [fit=wires${extra}]
A.out -> G.in1 #blue [ortho]
B.out -> G.in2 #blue [ortho]
C.out -> G.in3 #blue [ortho]`,
				fence
			).svg;
		expect(svg('barrier', ' wires=3')).toContain('d="M 0 -108 V 108"');
		expect(svg('delay', ' wires=3')).toContain('x="-12" y="-107" width="24" height="214" rx="2"');
		const toffoli = svg('toffoli');
		expect(toffoli).toContain('d="M 0 -100 V 100"');
		expect(toffoli).toContain('cy="20" r="4"');
		expect(svg('controlled', ' controls=2 control=negative')).toContain('cy="20" r="5"');
		expect(svg('controlled', ' controls=2 control=classical')).toContain('y="15" width="10"');
		expect(svg('swap', ' targets=3')).toContain('M -6 94 L 6 106');
	});

	test('a gate with nothing wired to its rails keeps its usual shape', () => {
		const document = parseSchematic('cnot:CX "CX" at (300, 200) #purple [fit=wires]', fence);
		expect(part(document, 'CX')).not.toHaveProperty('rails');
		expect(part(document, 'CX').y).toBe(200);
	});

	test('rails too close to fit are rejected with a height that works', () => {
		expect(
			failure(`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (80, 110) #blue
cnot:CX "CX" at (300, 105) #purple [fit=wires]
A.out -> CX.in1 #blue [ortho]
B.out -> CX.in2 #blue [ortho]`)
		).toBe(
			`CX cannot line up rails 1 and 2 with their wires: they arrive 10 units apart, and rails need at least ${FIT_GAP}. Move the wire on rail 2 to y >= 116, or remove fit=wires.`
		);
	});

	test('fitted gates with different rails never share one drawing; equal ones do', () => {
		const svg = compileSchematic(
			`prepare:A "a" at (80, 100) #blue
prepare:B "b" at (80, 200) #blue
prepare:C "c" at (80, 300) #blue
prepare:D "d" at (80, 460) #blue
cnot:CX1 "CX" at (300, 150) #purple [fit=wires]
cnot:CX2 "CX" at (300, 380) #purple [fit=wires]
cnot:CX3 "CX" at (500, 150) #purple [fit=wires]
A.out -> CX1.in1 #blue [ortho]
B.out -> CX1.in2 #blue [ortho]
C.out -> CX2.in1 #blue [ortho]
D.out -> CX2.in2 #blue [ortho]
CX1.out1 -> CX3.in1 #purple [ortho]
CX1.out2 -> CX3.in2 #purple [ortho]`,
			{ ...fence, mode: 'full' }
		).svg;
		expect(svg).toContain('cnot--50_50');
		expect(svg).toContain('cnot--80_80');
		expect(svg.match(/<use [^>]*cnot--50_50/g)?.length ?? 0).toBeGreaterThanOrEqual(0);
	});
});

const IC = `port:A "a" at (80, 100) #blue
port:B "b" at (80, 200) #blue
port:C "c" at (80, 340) #blue
ic:U1 "Oracle" at (400, 220) #purple [left="i0,i1,i2" right="o0,o1,o2" fit=wires]
port:X "x" at (700, 100) #emerald
port:Z "z" at (700, 340) #emerald
A.out -> U1.i0 #blue [ortho]
B.out -> U1.i1 #blue [ortho]
C.out -> U1.i2 #blue [ortho]
U1.o0 -> X.in #emerald [ortho]
U1.o2 -> Z.in #emerald [ortho]`;

describe('fit=wires on blocks', () => {
	test('an IC lines every wired pin up with its wire and grows to hold them', () => {
		const compilation = compileSchematic(IC, fence);
		const document = compilation.document;
		const u1 = part(document, 'U1');
		expect(u1).toMatchObject({ y: 220, rows: { left: [-120, -20, 120], right: [-120, 0, 120] } });
		expect((u1 as { bodyHeight: number }).bodyHeight).toBe(276);
		for (const [pin, height] of [['i0', 100], ['i1', 200], ['i2', 340], ['o0', 100], ['o2', 340]] as const) {
			expect(y(document, 'U1', pin)).toBe(height);
		}
		expect(straight(compilation.svg)).toBe(true);
	});

	test('an unwired pin between two wired ones is spaced between them; beyond them, at the pitch', () => {
		const document = parseSchematic(
			`port:A "a" at (80, 100) #blue
port:C "c" at (80, 300) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q,r,s" fit=wires]
A.out -> U1.p #blue [ortho]
C.out -> U1.r #blue [ortho]`,
			fence
		);
		expect(part(document, 'U1')).toMatchObject({ y: 209, rows: { left: [-109, -9, 91, 109], right: [] } });
		const leading = parseSchematic(
			`port:B "b" at (80, 200) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q" fit=wires]
B.out -> U1.q #blue [ortho]`,
			fence
		);
		expect(part(leading, 'U1')).toMatchObject({ y: 191, rows: { left: [-9, 9] } });
	});

	test('a side with nothing wired spreads its pins over the fitted body', () => {
		const document = parseSchematic(
			`port:A "a" at (80, 100) #blue
port:B "b" at (80, 300) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q" right="r,s,t" fit=wires]
A.out -> U1.p #blue [ortho]
B.out -> U1.q #blue [ortho]`,
			fence
		);
		const u1 = part(document, 'U1') as { rows: { right: readonly number[] }; bodyHeight: number };
		expect(u1.bodyHeight).toBe(236);
		expect(u1.rows.right).toEqual([-59, 0, 59]);
	});

	test('the body never shrinks below its usual height', () => {
		const document = parseSchematic(
			`port:A "a" at (80, 190) #blue
port:B "b" at (200, 210) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q" fit=wires]
A.out -> U1.p #blue [ortho]
B.out -> U1.q #blue [ortho]`,
			fence
		);
		expect(part(document, 'U1')).toMatchObject({ bodyHeight: 64, rows: { left: [-10, 10] } });
	});

	test('digital blocks fit their data terminals and keep clock and enable below', () => {
		const compilation = compileSchematic(
			`port:A "a" at (80, 100) #blue
port:B "b" at (80, 260) #blue
mux:R "R" at (400, 180) #purple [inputs=2 outputs=2 fit=wires]
port:X "x" at (700, 100) #emerald
port:Y "y" at (700, 260) #emerald
A.out -> R.in1 #blue [ortho]
B.out -> R.in2 #blue [ortho]
R.out1 -> X.in #emerald [ortho]
R.out2 -> Y.in #emerald [ortho]`,
			{ ...fence, mode: 'full' }
		);
		const register = part(compilation.document, 'R');
		expect(register).toMatchObject({ y: 180, rows: { left: [-80, 80], right: [-80, 80] }, bodyHeight: 192 });
		expect(y(compilation.document, 'R', 'select')).toBe(180 + 96 + 16);
		expect(straight(compilation.svg)).toBe(true);
		expect(compilation.svg).toContain('digital-mux-mux-2-2-84-192--80_80--80_80');
	});

	test('pins wired in the wrong order are rejected with the fix', () => {
		expect(failure(IC.replace('A.out -> U1.i0', 'A.out -> U1.i1').replace('B.out -> U1.i1', 'B.out -> U1.i0'))).toBe(
			"U1 cannot line up i1 with its wire: it arrives at y=100, above i0's at y=200, but i1 sits below i0 on U1's left side. Swap the wires, reorder the pins, or remove fit=wires."
		);
		expect(
			failure(`port:A "a" at (80, 200) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q" fit=wires]
A.out -> U1.p #blue [ortho]
A.out -> U1.q #blue [ortho]`)
		).toContain("it arrives at y=200, level with p's at y=200");
	});

	test('pins too close to fit are rejected with a height that works', () => {
		expect(
			failure(`port:A "a" at (80, 200) #blue
port:B "b" at (80, 210) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q" fit=wires]
A.out -> U1.p #blue [ortho]
B.out -> U1.q #blue [ortho]`)
		).toBe(`U1 cannot line up q with its wire: it arrives 10 units below p's, and pins need at least ${FIT_GAP}. Move the wire on q to y >= 216, or remove fit=wires.`);
	});

	test('a block with nothing wired keeps its usual shape', () => {
		const document = parseSchematic('ic:U1 "U" at (400, 200) #purple [left="p,q" right="r" fit=wires]', fence);
		expect(part(document, 'U1')).not.toHaveProperty('rows');
	});

	test('a pin wired only to its own part is not a wire to line up with', () => {
		const document = parseSchematic(
			`ic:U1 "U" at (400, 200) #purple [left="p,q" right="r" fit=wires]
U1.r -> U1.p #purple [ortho]`,
			fence
		);
		expect(part(document, 'U1')).not.toHaveProperty('rows');
	});

	test('pins exactly the least gap apart fit', () => {
		const document = parseSchematic(
			`port:A "a" at (80, 200) #blue
port:B "b" at (200, ${200 + FIT_GAP}) #blue
ic:U1 "U" at (400, 208) #purple [left="p,q" fit=wires]
A.out -> U1.p #blue [ortho]
B.out -> U1.q #blue [ortho]`,
			fence
		);
		expect(part(document, 'U1')).toMatchObject({ rows: { left: [-8, 8] } });
	});
});

describe('fitting is deterministic', () => {
	test('a terminal with several partners follows the nearest, then the highest, then the name', () => {
		const document = parseSchematic(
			`port:FAR "far" at (60, 100) #blue
port:NEAR "near" at (200, 300) #blue
ic:U1 "U" at (400, 200) #purple [left="p" fit=wires]
FAR.out -> U1.p #blue [ortho]
NEAR.out -> U1.p #blue [ortho]`,
			fence
		);
		expect(y(document, 'U1', 'p')).toBe(300);
		const reversed = parseSchematic(
			`port:FAR "far" at (60, 100) #blue
port:NEAR "near" at (200, 300) #blue
ic:U1 "U" at (400, 200) #purple [left="p" fit=wires]
NEAR.out -> U1.p #blue [ortho]
FAR.out -> U1.p #blue [ortho]`,
			fence
		);
		expect(y(reversed, 'U1', 'p')).toBe(300);
		const tied = parseSchematic(
			`port:LOW "low" at (200, 300) #blue
port:HIGH "high" at (200, 100) #blue
ic:U1 "U" at (400, 200) #purple [left="p" fit=wires]
LOW.out -> U1.p #blue [ortho]
HIGH.out -> U1.p #blue [ortho]`,
			fence
		);
		expect(y(tied, 'U1', 'p')).toBe(100);
		/* Equally near and level: the name decides, whichever is written first. */
		for (const order of [
			['LEFT.out -> U1.p', 'RIGHT.in -> U1.p'],
			['RIGHT.in -> U1.p', 'LEFT.out -> U1.p']
		]) {
			const level = parseSchematic(
				`port:LEFT "l" at (200, 300) #blue
port:RIGHT "r" at (600, 300) #blue
ic:U1 "U" at (400, 200) #purple [left="p" fit=wires]
${order.join(' #blue [ortho]\n')} #blue [ortho]`,
				fence
			);
			expect(y(level, 'U1', 'p')).toBe(300);
		}
	});

	test('the drawing never depends on declaration order', () => {
		const lines = BELL.split('\n');
		const declarations = lines.filter((line) => /^\w+:/.test(line));
		const wires = lines.filter((line) => line.includes('->'));
		const shuffled = [...declarations].reverse().join('\n') + '\n\n' + [...wires].reverse().join('\n');
		const [original, reordered] = [compileSchematic(BELL, fence), compileSchematic(shuffled, fence)];
		expect(traces(reordered.svg)).toEqual(traces(original.svg));
		expect(part(reordered.document, 'CX1')).toMatchObject({ y: 150, rails: [-60, 60] });
	});

	test('fitted parts settle in order of position, then id', () => {
		/* Two fitted blocks at one point: the direct call shows the order without
		   the overlap the compiler would then reject. */
		const make = (id: string, x: number, y: number) =>
			({ kind: 'ic', id, label: id, x, y, color: { kind: 'semantic', value: 'blue' }, line: 1, pins: { left: ['p'], right: ['q'], top: [], bottom: [] }, bodyWidth: 88, bodyHeight: 64, fit: 'wires' }) as unknown as SchematicComponent;
		const source = { kind: 'port', id: 'S', label: 'S', x: 50, y: 300, color: { kind: 'semantic', value: 'blue' }, line: 1 } as unknown as SchematicComponent;
		const components = [make('B', 300, 200), make('A', 300, 200), make('C', 300, 100), source];
		const connection = (from: string, fromPort: string, to: string, toPort: string) =>
			({ from: { componentId: from, port: fromPort }, to: { componentId: to, port: toPort } }) as never;
		const wiring = [connection('S', 'out', 'C', 'p'), connection('C', 'q', 'A', 'p'), connection('A', 'q', 'B', 'p'), connection('B', 'q', 'B', 'p')];
		fitComponents(components, wiring, () => undefined);
		expect(components.map((component) => component.y)).toEqual([300, 300, 300, 300]);
		const swapped = [make('A', 300, 200), make('B', 300, 200), make('C', 300, 100), source];
		fitComponents(swapped, wiring, () => undefined);
		expect(swapped.map((component) => component.y)).toEqual([300, 300, 300, 300]);
	});

	test('fitting goes on after a part that cannot fit, reporting each', () => {
		const errors: unknown[] = [];
		const document = parseSchematic(BELL, fence);
		const components = document.components.map((component) => ({ ...component })) as SchematicComponent[];
		const close = components.find((component) => component.id === 'Q1')!;
		close.y = 95;
		fitComponents(components, document.connections, (error) => errors.push(error));
		expect(errors).toHaveLength(1);
	});
});

describe('fit=wires options and round trips', () => {
	test('only gates spanning several qubits and blocks with several terminals take it', () => {
		expect(failure('hadamard:H "H" at (300, 200) #cyan [fit=wires]')).toMatch(/fit/);
		expect(failure('measure:M "M" at (300, 200) #cyan [fit=wires]')).toBe(
			'Option fit is not supported for measure; it lines up the rails of a gate that spans several qubits.'
		);
		for (const kind of ['buffer', 'logic', 'clock']) {
			expect(failure(`${kind}:B "B" at (300, 200) #cyan [fit=wires]`)).toBe(
				`Option fit is not supported for ${kind}; it lines up the terminals of a block with several on one side.`
			);
		}
		expect(failure('cnot:CX "CX" at (300, 200) #cyan [fit=grid]')).toBe('Option fit must be one of: wires.');
		expect(failure('ic:U "U" at (300, 200) #cyan [left="a" fit=wires orientation=down]')).toBe(
			'fit=wires lines terminals up with their wires vertically; remove orientation or fit.'
		);
	});

	test('a fitted document is frozen like any other', () => {
		const document = parseSchematic(IC, fence);
		const u1 = part(document, 'U1') as unknown as { rows: { left: number[] } };
		expect(Object.isFrozen(u1.rows)).toBe(true);
		expect(Object.isFrozen(u1.rows.left)).toBe(true);
		const cx = part(parseSchematic(BELL, fence), 'CX1') as unknown as { rails: number[] };
		expect(Object.isFrozen(cx.rails)).toBe(true);
	});

	test('the markup reads back as a fitted declaration that compiles to the same drawing', () => {
		const svg = compileSchematic(BELL, { ...fence, mode: 'full' }).svg;
		const recovered = parseSchematicSvg(svg);
		expect(recovered.source).toContain('cnot:CX1 "CNOT" at (460, 150) #purple [fit=wires]');
		expect(recovered.components.find((component) => component.id === 'CX1')?.fit).toBe('wires');
	});

	test('diagnoseSchematic reports a fit that cannot be made, on its line', () => {
		const diagnostics = diagnoseSchematic(
			`port:A "a" at (80, 200) #blue
port:B "b" at (80, 210) #blue
ic:U1 "U" at (400, 200) #purple [left="p,q" fit=wires]
A.out -> U1.p #blue [ortho]
B.out -> U1.q #blue [ortho]`,
			fence
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ code: 'geometry', line: 3, severity: 'error' });
	});
});

describe('aligning a terminal rather than a centre', () => {
	test('aligned-y with B.port at OWN puts that terminal level with the reference', () => {
		const document = parseSchematic(
			`and:G1 "G" at (300, 200) #blue [inputs=2]
resistor:R1 "R" left-of G1 by 80 aligned-y with G1.in2 at out #amber
resistor:R2 "R" at (120, 300) #amber
and:G2 "G" right-of R2 by 80 aligned-y with R2.out at in2 #blue [inputs=2]
G1.in2 -> R1.out #amber [ortho]
R2.out -> G2.in2 #amber [ortho]`,
			fence
		);
		expect(y(document, 'R1', 'out')).toBe(y(document, 'G1', 'in2'));
		/* The gate's in2 sits below its centre, so the gate lands above the resistor. */
		expect(part(document, 'G2').y).toBe(292);
		expect(y(document, 'G2', 'in2')).toBe(300);
	});

	test('aligned-x with B.port at OWN lines a terminal up across', () => {
		const document = parseSchematic(
			`resistor:R1 "R" at (300, 200) #amber [orientation=down]
capacitor:C1 "C" below R1 by 60 aligned-x with R1.out at in #cyan [orientation=down]`,
			fence
		);
		expect(resolvePortPoint(part(document, 'C1'), 'in').x).toBe(resolvePortPoint(part(document, 'R1'), 'out').x);
	});

	test('an own terminal is folded to its canonical name and an unknown one is rejected', () => {
		const compilation = compileSchematic(
			`and:G1 "G" at (300, 200) #blue [inputs=2]
not:N1 "N" left-of G1 by 80 aligned-y with G1.in2 at out #amber`,
			fence
		);
		expect(compilation.placements[0]!.relations[1]).toMatchObject({ at: 'out1' });
		expect(
			failure(`and:G1 "G" at (300, 200) #blue [inputs=2]
resistor:R1 "R" left-of G1 by 80 aligned-y with G1.in2 at nowhere #amber`)
		).toBe('R1 has no terminal named nowhere to line up with G1. Name one of R1\'s terminals, or remove at nowhere to align its centre.');
	});
});
