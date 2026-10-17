/**
 * Multi-terminal nets are trees, and `trunk` is the 0.x spelling of that.
 *
 * Since 1.0 the router grows every orthogonal signal net as one tree: each
 * further wire joins the nearest copper of its own net, and every junction is
 * drawn. `trunk` is still parsed, validated and recorded — the parser decides
 * which end joins the net from the source text alone — but the drawing no
 * longer depends on it.
 */
import { describe, expect, test } from 'vitest';

import { compileSchematic } from '../src/index.js';
import { parseSchematicSvg } from '../src/decompile.js';

const FENCE = { bounds: { width: 600, height: 560 }, title: 'trunk' } as const;

/** A supply fanned out to four resistors; the last three branch off the first. */
function fanOut(option = 'ortho trunk'): string {
	return [
		'source:VIN "5 V" at (100, 260) #blue [type=voltage-dc]',
		'resistor:R1 "1 k" at (420, 100) #amber',
		'resistor:R2 "2 k" at (420, 220) #amber',
		'resistor:R3 "3 k" at (420, 340) #amber',
		'resistor:R4 "4 k" at (420, 460) #amber',
		'VIN.positive -> R1.in #blue [ortho]',
		`VIN.positive -> R2.in #blue [${option}]`,
		`VIN.positive -> R3.in #blue [${option}]`,
		`VIN.positive -> R4.in #blue [${option}]`
	].join('\n');
}

/** Visible trace path data in source order. */
function traces(svg: string): string[] {
	return [...svg.matchAll(/schematic-trace"[^>]*\sd="([^"]+)"/g)].map((match) => match[1]!);
}

/** Junction dot centres in source order. */
function junctions(svg: string): string[] {
	return [...svg.matchAll(/schematic-junction" fill="currentColor" cx="([^"]+)" cy="([^"]+)"/g)].map(
		(match) => `${match[1]},${match[2]}`
	);
}

describe('routing', () => {
	test('each wire joins the nearest copper of its net, at a dot', () => {
		const result = compileSchematic(fanOut(), { ...FENCE, mode: 'full' });
		expect(result.routing.attempts).toBe(0);
		expect(traces(result.svg)).toEqual([
			/* The first wire lays a spine one pitch off VIN's escape point. */
			'M 142 260 H 154 V 100 H 378',
			/* R2 leaves the spine rather than VIN's terminal. */
			'M 154 220 H 378',
			/* R3 taps R2's wire, held two pitches off R2's terminal. */
			'M 348 220 V 340 H 378',
			/* R4 continues the drop R3 started: a clean L, not a midpoint dogleg. */
			'M 348 340 V 460 H 378'
		]);
		/* Each junction is the first point of the branch it belongs to. */
		expect(junctions(result.svg)).toEqual(['154,220', '348,220', '348,340']);
		expect(result.svg.match(/data-wire-trunk="from"/g)).toHaveLength(3);
	});

	test('the same net without trunk draws the same tree', () => {
		const plain = compileSchematic(fanOut('ortho'), { ...FENCE, mode: 'full' });
		const trunk = compileSchematic(fanOut(), { ...FENCE, mode: 'full' });
		expect(traces(plain.svg)).toEqual(traces(trunk.svg));
		expect(junctions(plain.svg)).toEqual(junctions(trunk.svg));
		/* Only the recorded option differs. */
		expect(plain.svg).not.toContain('data-wire-trunk');
	});

	test('compact modes compound junctions with the endpoint dots', () => {
		/* Four wire ends plus three junctions, all one 3-unit circle subpath. */
		for (const mode of ['default', 'embedded-css'] as const) {
			const result = compileSchematic(fanOut(), { ...FENCE, mode });
			expect(result.svg.match(/a 3 3 0 1 0 6 0/g)).toHaveLength(7);
		}
	});

	test('a branch joining at its destination ends on the net and keeps its direction', () => {
		const result = compileSchematic(
			[
				'resistor:R1 "a" at (150, 100) #amber',
				'resistor:R2 "b" at (150, 300) #amber',
				'junction:J "j" at (450, 200) #blue',
				'resistor:R5 "c" at (450, 460) #amber',
				'resistor:R6 "d" at (150, 460) #amber',
				/* Another net, placed first, which the branch must not tap. */
				'R6.out -> R5.in #slate [ortho]',
				'R1.out -> J.node #blue [ortho]',
				'R2.out -> J.node #blue [ortho trunk]'
			].join('\n'),
			{ ...FENCE, mode: 'full' }
		);
		expect(result.document.connections[2]!.trunk).toBe('to');
		expect(result.svg).toContain('data-wire-trunk="to"');
		/* Drawn from R2 towards the tap, so the endpoint dot every signal wire
		   ends in is the junction; no separate junction dot is needed. */
		expect(traces(result.svg)[2]).toBe('M 192 300 H 216 V 100');
		expect(junctions(result.svg)).toEqual([]);
	});

	test('the junction is where a branch leaves the net, not where it was tapped', () => {
		/*
		 * The branch may not tap within two pitches of R2's terminal, so it sets
		 * off along the wire and turns at the first lattice column clear of it;
		 * the dot belongs at that turn.
		 */
		const result = compileSchematic(
			[
				'resistor:R1 "a" at (100, 100) #amber',
				'resistor:R2 "b" at (500, 100) #amber',
				'resistor:R3 "c" at (500, 300) #amber [orientation=left]',
				'R1.out -> R2.in #blue [ortho]',
				'R1.out -> R3.out #blue [ortho trunk]'
			].join('\n'),
			{ ...FENCE, mode: 'full' }
		);
		expect(traces(result.svg)[1]).toBe('M 432 100 V 300 H 458');
		expect(junctions(result.svg)).toEqual(['432,100']);
	});

	test('a branch bridged over another net keeps its junction', () => {
		/* The crossing pass rebuilds a bridged trace; the junction must survive it. */
		const result = compileSchematic(
			[
				'resistor:R1 "a" at (100, 100) #amber',
				'resistor:R2 "b" at (500, 100) #amber',
				'resistor:R3 "c" at (500, 300) #amber [orientation=left]',
				'port:P "P" at (300, 200) #slate',
				'port:Q "Q" at (640, 200) #slate [orientation=left]',
				'R1.out -> R2.in #blue [ortho]',
				'P.out -> Q.in #slate [ortho]',
				'R1.out -> R3.out #blue [ortho trunk]'
			].join('\n'),
			{ bounds: { width: 700, height: 560 }, title: 'bridged', mode: 'full' }
		);
		expect(traces(result.svg)[2]).toBe('M 432 100 V 177 A 5 5 0 0 0 432 187 V 300 H 458');
		expect(junctions(result.svg)).toEqual(['432,100']);
	});

	test('a net with no orthogonal copper yet routes the branch from its terminal', () => {
		const result = compileSchematic(
			[
				'resistor:R1 "a" at (150, 100) #amber',
				'resistor:R2 "b" at (450, 100) #amber',
				'resistor:R3 "c" at (450, 300) #amber',
				'R1.out -> R2.in #blue [line]',
				'R1.out -> R3.in #blue [ortho trunk]'
			].join('\n'),
			{ ...FENCE, mode: 'full' }
		);
		expect(traces(result.svg)[1]).toBe('M 192 100 H 396 V 300 H 408');
		expect(junctions(result.svg)).toEqual([]);
	});

	test('a branch that cannot reach its terminal names both ends', () => {
		/* R3's input is walled in by three blockers; one pass, so the diagnostic
		   is the branch's own rather than a later retry's. */
		expect(() =>
			compileSchematic(
				[
					'resistor:R1 "a" at (100, 100) #amber',
					'resistor:R2 "b" at (400, 100) #amber',
					'resistor:R3 "c" at (450, 300) #amber',
					'resistor:B1 "x" at (388, 300) #slate [orientation=down]',
					'resistor:B2 "x" at (450, 260) #slate',
					'resistor:B3 "x" at (450, 340) #slate',
					'R1.out -> R2.in #blue [ortho]',
					'R1.out -> R3.in #blue [ortho trunk]'
				].join('\n'),
				{ bounds: { width: 700, height: 560 }, title: 'walled', limits: { routingAttempts: 1 } }
			)
		).toThrow(
			"Line 8: No orthogonal route from R1.out to R3.in clears every component and earlier trace: move one of them apart, widen the fence bounds, or join the traces that meet with a shared net."
		);
	});

	test('a branch joins a reversal bus without any rescue pass', () => {
		/*
		 * Thirteen reversed wires once needed a separate bundle layout, which a
		 * branch could not take part in. Routed by net, the bus completes in the
		 * first pass and the branch ends on L6's wire, its endpoint dot the
		 * junction.
		 */
		const lines: string[] = ['port:Y "Y" at (80, 1800) #blue'];
		for (let index = 0; index < 13; index += 1) {
			lines.push(`port:L${index} "L" at (80, ${100 + index * 130}) #blue`);
			lines.push(`port:R${index} "R" at (1200, ${100 + (12 - index) * 130}) #blue`);
		}
		for (let index = 0; index < 13; index += 1) lines.push(`L${index}.out -> R${index}.in #blue [ortho]`);
		const fence = { bounds: { width: 1400, height: 1900 }, title: 'bus', mode: 'full' } as const;
		const result = compileSchematic(`${lines.join('\n')}\nY.out -> R6.in #blue [ortho trunk]`, fence);
		expect(result.routing.attempts).toBe(0);
		expect(result.routing.nudged).toBe(false);
		expect(traces(result.svg).at(-1)).toMatch(/^M 122 1800 H 156 V 1665 A .* V 880$/);
	});

	test('wires of other nets do not spend the tap budget', () => {
		/*
		 * Eight other-net wires sit between the trunk and R3, all nearer than the
		 * trunk. A tap on any of them is illegal — the branch would meet a foreign
		 * net at a T — so if they were offered as candidates they would use every
		 * one of the eight attempts and the trunk would never be tried.
		 */
		const lines = [
			'resistor:R1 "a" at (100, 60) #amber',
			'resistor:R2 "b" at (600, 60) #amber',
			'resistor:R3 "c" at (450, 580) #amber'
		];
		for (let index = 0; index < 8; index += 1) {
			lines.push(`resistor:A${index} "w" at (150, ${140 + index * 50}) #slate`);
			lines.push(`resistor:B${index} "w" at (550, ${140 + index * 50}) #slate`);
		}
		lines.push('R1.out -> R2.in #blue [ortho]');
		for (let index = 0; index < 8; index += 1) lines.push(`A${index}.out -> B${index}.in #slate [ortho]`);
		lines.push('R1.out -> R3.in #blue [ortho trunk]');
		const result = compileSchematic(lines.join('\n'), {
			bounds: { width: 700, height: 660 },
			title: 'budget',
			mode: 'full',
			limits: { routingAttempts: 1 }
		});
		expect(junctions(result.svg)).toHaveLength(1);
	});
});

describe('declaration', () => {
	const declare = (connections: string) =>
		compileSchematic(
			[
				'resistor:R1 "a" at (150, 100) #amber',
				'resistor:R2 "b" at (450, 100) #amber',
				'resistor:R3 "c" at (450, 300) #amber',
				'class:A "A" at (150, 450) #blue',
				'class:B "B" at (450, 450) #blue',
				connections
			].join('\n'),
			FENCE
		);

	test('trunk applies only to orthogonal signal wires', () => {
		const advice = 'is marked trunk, which only applies to orthogonal signal wires; add ortho, or drop trunk.';
		expect(() => declare('R1.out -> R2.in #blue [ortho]\nR1.out -> R3.in #blue [line trunk]')).toThrow(
			`Line 7: R1.out -> R3.in ${advice}`
		);
		expect(() => declare('R1.out -> R2.in #blue [ortho]\nR1.out -> R3.in #blue [bezier trunk]')).toThrow(
			advice
		);
		expect(() => declare('A.right -> B.left #blue [ortho association]\nA.right -> B.top #blue [ortho association trunk]')).toThrow(
			advice
		);
	});

	test('a branch needs exactly one terminal already wired above it', () => {
		expect(() => declare('R1.out -> R3.in #blue [ortho trunk]\nR1.out -> R2.in #blue [ortho]')).toThrow(
			'Line 6: R1.out -> R3.in is marked trunk, but neither terminal is wired above it, so there is no copper to branch from; declare a connection that reaches R1.out or R3.in first, or drop trunk.'
		);
		expect(() =>
			declare('R1.out -> R2.in #blue [ortho]\nR2.out -> R3.in #blue [ortho]\nR1.out -> R3.in #blue [ortho trunk]')
		).toThrow(
			'Line 8: R1.out -> R3.in is marked trunk, but both terminals are already wired above it, so there is nothing new to branch out to; drop trunk.'
		);
	});

	test('a UML connector wires nothing a branch could tap', () => {
		expect(() =>
			declare('A.right -> B.left #blue [ortho association]\nA.right -> R3.in #blue [ortho trunk]')
		).toThrow('neither terminal is wired above it');
	});

	test('the joining end resolves from the declarations above, not from routing', () => {
		const from = declare('R1.out -> R2.in #blue [ortho]\nR1.out -> R3.in #blue [ortho trunk]');
		const to = declare('R1.out -> R2.in #blue [ortho]\nR3.out -> R2.in #blue [ortho trunk]');
		expect(from.document.connections[1]!.trunk).toBe('from');
		expect(to.document.connections[1]!.trunk).toBe('to');
	});

	test('a marker cannot sit on the end that joins the net', () => {
		expect(() =>
			declare('R1.out -> R2.in #blue [ortho]\nR1.out -> R3.in #blue [ortho trunk marker-start=dot]')
		).toThrow(
			"Line 7: R1.out -> R3.in branches off the trunk at R1.out's end, so its marker-start has no terminal to sit on; move the marker to the connection that reaches R1.out."
		);
		expect(() => declare('R1.out -> R2.in #blue [ortho]\nR3.out -> R2.in #blue [ortho trunk arrow]')).toThrow(
			"branches off the trunk at R2.in's end, so its marker-end has no terminal to sit on"
		);
		/* The free end may carry one. */
		expect(() => declare('R1.out -> R2.in #blue [ortho]\nR1.out -> R3.in #blue [ortho trunk arrow]')).not.toThrow();
	});

	test('trunk is declared once', () => {
		expect(() => declare('R1.out -> R2.in #blue [ortho]\nR1.out -> R3.in #blue [ortho trunk trunk]')).toThrow(
			'Line 7: Connection trunk can only be declared once.'
		);
	});
});

describe('recovery', () => {
	test('a full-mode drawing reads back with its trunk options', () => {
		const result = compileSchematic(fanOut(), { ...FENCE, mode: 'full' });
		const recovered = parseSchematicSvg(result.svg);
		expect(recovered.connections.map((connection) => connection.trunk)).toEqual([
			undefined,
			true,
			true,
			true
		]);
		expect(recovered.source).toContain('VIN.positive -> R4.in #blue [ortho trunk]');
		/* And the recovered source draws the same wires. */
		const again = compileSchematic(recovered.source, { ...FENCE, mode: 'full' });
		expect(traces(again.svg)).toEqual(traces(result.svg));
	});
});
