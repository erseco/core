/**
 * Adversarial cover for the five defects an audit found in 0.3.8, for the
 * retired component and connection ceilings, and for the budget that replaced
 * them.
 *
 * Each block states the defect or the contract, then pins the property that
 * makes it hold, rather than the incidental output that happened to change.
 * Where the old behaviour was *accepted by the suite* — a compound path
 * carrying one arrowhead for three wires, a transistor lead wired to itself —
 * the assertion here is deliberately the inverse of what shipped.
 */
import { describe, expect, test } from 'vitest';

import {
	canonicalPortName,
	compileSchematic,
	componentTextAnchors,
	connectionLabelPoint,
	inspectSchematic,
	parseSchematic,
	renderSchematic,
	resolvePortPoint,
	routeConnections,
	SCHEMATIC_LIMITS,
	SCHEMD_OUTPUT_MODES,
	type SchematicComponent,
	type SchematicConnection,
	type SchematicDocument,
	type SchematicFence,
	type SchematicLimitOptions
} from '../src/index.js';

const fence: SchematicFence = { bounds: { width: 1000, height: 700 }, title: 'Regression fixture' };

/** Every coordinate a generated SVG contains, as written. */
function emittedNumbers(svg: string): string[] {
	return svg.match(/-?\d+\.\d+/g) ?? [];
}

/** One reversal bus: `count` traces left to right, paired in opposite order. */
function crossbar(count: number, gap = 120, span = 900): string {
	const nodes: string[] = [];
	const wires: string[] = [];
	for (let index = 0; index < count; index += 1) {
		nodes.push(`port:L${index} "L" at (60,${80 + index * gap}) #blue`);
		nodes.push(`port:R${index} "R" at (${span},${80 + (count - 1 - index) * gap}) #blue`);
		wires.push(`L${index}.out -> R${index}.in #blue [ortho]`);
	}
	return [...nodes, ...wires].join('\n');
}

/** Axis-aligned spans of one path's `M`/`H`/`V` walk, for overlap checking. */
function axisSpans(path: string): { x: number; y: number; horizontal: boolean; from: number; to: number }[] {
	const spans: { x: number; y: number; horizontal: boolean; from: number; to: number }[] = [];
	const tokens = path.match(/[MHVA][^MHVA]*/g) ?? [];
	let x = 0;
	let y = 0;
	for (const token of tokens) {
		const numbers = (token.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
		if (token[0] === 'M') {
			x = numbers[0]!;
			y = numbers[1]!;
		} else if (token[0] === 'H') {
			const next = numbers[0]!;
			spans.push({ x, y, horizontal: true, from: Math.min(x, next), to: Math.max(x, next) });
			x = next;
		} else if (token[0] === 'V') {
			const next = numbers[0]!;
			spans.push({ x, y, horizontal: false, from: Math.min(y, next), to: Math.max(y, next) });
			y = next;
		} else {
			/* Bridge arc: it only hops an existing crossing, so advance the pen. */
			x = numbers[5]!;
			y = numbers[6]!;
		}
	}
	return spans;
}

describe('compound paths never swallow an endpoint marker', () => {
	/*
	 * SVG paints marker-start at the first vertex of a path element and
	 * marker-end at its last — not once per subpath. Batching traces that carry
	 * closed markers therefore rendered one arrowhead however many wires shared
	 * the batch, and every marker fixture in the suite used a distinct colour per
	 * wire, which put each one in its own batch and hid it.
	 */
	const marked = (marker: string, count: number): string => {
		const nodes: string[] = [];
		const wires: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const y = 90 + index * 110;
			nodes.push(`port:L${index} "L" at (90,${y}) #blue`);
			nodes.push(`port:R${index} "R" at (520,${y}) #blue`);
			wires.push(`L${index}.out -> R${index}.in #blue [${marker}]`);
		}
		return [...nodes, ...wires].join('\n');
	};

	test.each([
		['arrow', 'marker-end'],
		['dot', 'marker-end'],
		['marker-end=diamond-filled', 'marker-end'],
		['marker-start=arrow', 'marker-start'],
		['marker-start=dot', 'marker-start']
	])('renders %s once per declaring connection in every mode', (option, attribute) => {
		const source = marked(option, 4);
		for (const mode of SCHEMD_OUTPUT_MODES) {
			const { svg } = compileSchematic(source, { ...fence, mode, idPrefix: 'marker' });
			expect(svg.match(new RegExp(`${attribute}="url\\(#`, 'g'))).toHaveLength(4);
		}
	});

	test('keeps unmarked traces compounded while marked ones stand alone', () => {
		const source = `port:A "A" at (90,90) #blue
port:B "B" at (520,90) #blue
port:C "C" at (90,220) #blue
port:D "D" at (520,220) #blue
port:E "E" at (90,350) #blue
port:F "F" at (520,350) #blue
A.out -> B.in #blue [arrow]
C.out -> D.in #blue
E.out -> F.in #blue`;
		const { svg } = compileSchematic(source, { ...fence, idPrefix: 'mixed' });
		const traces = [...svg.matchAll(/class="[^"]*schematic-trace[^"]*" d="([^"]*)"/g)].map(
			(match) => match[1]!
		);
		/* One path for the marked wire, one compounding the two unmarked ones. */
		expect(traces.map((trace) => (trace.match(/M /g) ?? []).length)).toEqual([1, 2]);
		expect(svg.match(/marker-end="url\(#/g)).toHaveLength(1);
	});

	test('leaves open markers batching on their own carriers', () => {
		const source = `class:A "A" at (150,120) #blue
class:B "B" at (600,120) #blue
class:C "C" at (150,320) #blue
class:D "D" at (600,320) #blue
A.right -> B.left #blue [realization]
C.right -> D.left #blue [realization]`;
		const { svg } = compileSchematic(source, { ...fence, idPrefix: 'open' });
		/* Both triangles paint, and neither rides on the compounded trace. */
		expect(svg.match(/marker-end="url\(#[^"]*-marker-triangle\)"/g)).toHaveLength(2);
		expect(svg.match(/schematic-marker-carrier/g)).toHaveLength(2);
	});
});

describe('orthogonal routing completes a reversal bus', () => {
	/*
	 * The router scored reuse of an occupied channel as an expensive but legal
	 * option while `routeConnections` rejected it outright, so it could return a
	 * route it had already proved would be thrown out. A four-wire crossbar — an
	 * ordinary figure, and one with no DSL workaround, since crossing traces must
	 * be orthogonal — failed to compile from the third wire on.
	 */
	test.each([2, 3, 4, 6, 8])('compiles a %i-wire reversal on an open canvas', (count) => {
		const bounds = { width: 1000, height: 200 + count * 120 };
		const { document, svg, routing } = compileSchematic(crossbar(count), {
			bounds,
			title: 'Reversal bus',
			idPrefix: `bus-${count}`
		});
		expect(document.connections).toHaveLength(count);
		expect(svg).not.toContain('NaN');
		/*
		 * On the *first pass*, and this clause is load-bearing. 0.5 added rip-up,
		 * which retries around a trace that cannot be placed — and in doing so it can
		 * paper over a router defect that used to fail loudly here. Asserting only
		 * that these compile would let the reservation of terminal approaches, the
		 * channel-lane offer, and the contact pricing all regress silently, with the
		 * retry loop quietly absorbing the cost. A bus this size is an ordinary
		 * figure and must not need a retry.
		 */
		expect(routing.attempts).toBe(0);
	});

	test('lays every trace of a reversal bus in its own channel', () => {
		const count = 6;
		const bounds = { width: 1000, height: 200 + count * 120 };
		const { document } = compileSchematic(crossbar(count), { bounds, title: 'Reversal bus' });
		const routes = renderSchematic(document, { bounds, title: 'Reversal bus', mode: 'full' });
		const paths = [...routes.matchAll(/class="[^"]*schematic-trace[^"]*" d="([^"]*)"/g)].map(
			(match) => axisSpans(match[1]!)
		);
		/*
		 * The property the old router violated: no two traces of different nets
		 * may share a channel over any length. Bridges cover crossings; a
		 * collinear overlap can never be drawn legibly.
		 */
		for (let left = 0; left < paths.length; left += 1) {
			for (let right = left + 1; right < paths.length; right += 1) {
				for (const first of paths[left]!) {
					for (const second of paths[right]!) {
						if (first.horizontal !== second.horizontal) continue;
						const sameChannel = first.horizontal ? first.y === second.y : first.x === second.x;
						if (!sameChannel) continue;
						const overlap =
							Math.min(first.to, second.to) - Math.max(first.from, second.from);
						expect(overlap).toBeLessThan(0);
					}
				}
			}
		}
	});

	test('separates two nets that share one column instead of rejecting them', () => {
		const source = `port:T1 "T1" at (300,80) #blue [orientation=down]
port:B1 "B1" at (300,560) #blue [orientation=up]
port:T2 "T2" at (300,200) #cyan [orientation=down]
port:B2 "B2" at (300,420) #cyan [orientation=up]
T1.out -> B1.in #blue [ortho]
T2.out -> B2.in #cyan [ortho]`;
		const { svg } = compileSchematic(source, { ...fence, mode: 'full', idPrefix: 'column' });
		const traces = [...svg.matchAll(/class="[^"]*schematic-trace[^"]*" d="([^"]*)"/g)].map(
			(match) => match[1]!
		);
		expect(traces).toHaveLength(2);
		expect(traces[0]).not.toBe(traces[1]);
	});

	test('spends a detour to avoid a bridge it does not need', () => {
		/*
		 * A bridge crossing is legal but not free, and the sparse search is the one
		 * place that trade-off is decided edge by edge. Priced at zero the third
		 * trace below hops the second one for nothing; priced properly it goes
		 * round, and the diagram carries no arc at all.
		 */
		const source = `port:N0 "N" at (580,480) #blue [orientation=down]
port:N1 "N" at (80,480) #blue [orientation=right]
port:N2 "N" at (280,480) #blue [orientation=down]
port:N3 "N" at (480,380) #blue [orientation=up]
port:N4 "N" at (580,780) #blue [orientation=left]
port:N5 "N" at (280,280) #blue [orientation=up]
N1.out -> N2.in #blue [ortho]
N3.in -> N2.in #blue [ortho]
N4.out -> N5.out #blue [ortho]`;
		const { svg } = compileSchematic(source, {
			bounds: { width: 900, height: 900 },
			title: 'Bridge economy',
			mode: 'full',
			idPrefix: 'economy'
		});
		expect(svg).not.toContain(' A ');
		expect(
			[...svg.matchAll(/schematic-trace[^"]*" d="([^"]*)"/g)].map((match) => match[1])
		).toEqual([
			'M 122 480 H 134 V 412 H 280 V 438',
			'M 480 422 V 552 H 250 V 412',
			'M 538 780 H 510 V 212 H 280 V 238'
		]);
		/* The two wires into N2.in are one net: the second joins the first at a
		   dot, clear of the pin and its lead, instead of running its own lead into
		   it. Every wire leaves its pin straight through the pin's own text and
		   turns only beyond it. */
		expect(svg).toMatch(/schematic-node-fill" fill="currentColor" cx="250" cy="412" r="3"/);
	});

	test('routes identically on every compile of one source', () => {
		const source = crossbar(5);
		const bounds = { width: 1000, height: 800 };
		const first = compileSchematic(source, { bounds, title: 'Determinism', idPrefix: 'run' });
		const second = compileSchematic(source, { bounds, title: 'Determinism', idPrefix: 'run' });
		expect(second.svg).toBe(first.svg);
	});

	test('names both endpoints and a remedy when no channel is left', () => {
		/* Two facing terminals six units apart leave no corridor for either net. */
		const source = `port:A "A" at (60,300) #blue
port:B "B" at (150,300) #blue
port:X "X" at (60,120) #blue
port:Y "Y" at (600,480) #blue
A.out -> Y.in #blue [ortho]
B.in -> X.in #blue [ortho]`;
		expect(() => compileSchematic(source, { ...fence })).toThrow(
			'Line 6: A.out and B.in sit too close to route apart as separate nets: the wires leaving them would touch. Move one of them away, or join them with a shared net.'
		);
	});
});

describe('port aliases address one terminal everywhere', () => {
	/*
	 * `SchematicEndpoint.port` is documented as canonical, but the parser never
	 * normalized it, so topology, contact validation, the netlist and the design
	 * rules all keyed on whichever spelling the author happened to type. Two
	 * spellings of one pin became two terminals that merely coincided.
	 */
	const aliasFixture = (left: string, right: string): string =>
		`resistor:R1 "R" at (200,300) #amber
port:A "A" at (520,160) #blue
port:B "B" at (520,440) #blue
R1.${left} -> A.in #blue [ortho]
R1.${right} -> B.in #blue [ortho]`;

	test('treats every spelling of one lead as one terminal', () => {
		const canonical = parseSchematic(aliasFixture('out', 'out'), fence);
		for (const [left, right] of [
			['out', 'r'],
			['r', 'right'],
			['right', 'out']
		] as const) {
			const aliased = parseSchematic(aliasFixture(left, right), fence);
			expect(aliased.connections).toEqual(canonical.connections);
		}
	});

	test.each([
		['resistor:R1 "R" at (200,300) #amber', 'R1', ['in', 'left', 'l'], 'in'],
		['resistor:R1 "R" at (200,300) #amber', 'R1', ['out', 'right', 'r'], 'out'],
		['diode:D1 "D" at (200,300) #amber', 'D1', ['cathode', 'k', 'c'], 'cathode'],
		['transistor:Q1 "Q" at (200,300) #amber [type=nmos]', 'Q1', ['emitter', 'source', 'e', 's'], 'source'],
		['source:V1 "V" at (200,300) #amber', 'V1', ['out', 'positive'], 'positive'],
		['junction:J1 "J" at (200,300) #amber', 'J1', ['in', 'out', 'node'], 'node'],
		['and:G1 "G" at (200,300) #amber', 'G1', ['in', 'in1'], 'in1'],
		['class:C1 "C" at (200,300) #amber', 'C1', ['in', 'left'], 'left']
	])('canonicalizes %s aliases to one name', (declaration, id, aliases, canonical) => {
		const document = parseSchematic(declaration, fence);
		const component = document.components.find(
			(candidate: SchematicComponent) => candidate.id === id
		)!;
		for (const alias of aliases) {
			expect(canonicalPortName(component, alias)).toBe(canonical);
		}
	});

	test('keeps two pins drawn at one point distinct', () => {
		/* A flip-flop renders preset and clear on the same stub; they are still
		   two logical pins, so neither may absorb the other. */
		const document = parseSchematic('flipflop:F1 "F" at (300,300) #amber', fence);
		const flipflop = document.components[0]!;
		expect(canonicalPortName(flipflop, 'preset')).toBe('preset');
		expect(canonicalPortName(flipflop, 'clear')).toBe('clear');
	});

	test('applies design rules to the aliased spelling', () => {
		const rules = (port: string): string[] =>
			inspectSchematic(
				parseSchematic(
					`source:V1 "5V" at (200,300) #amber
power:P1 "VCC" at (600,300) #amber
V1.${port} -> P1.in #amber [ortho]`,
					fence
				)
			).diagnostics.map((diagnostic) => diagnostic.code);
		expect(rules('positive')).toContain('shorted-supply');
		expect(rules('out')).toEqual(rules('positive'));
	});

	test('detects a duplicate connection written with different aliases', () => {
		const document = parseSchematic(
			`resistor:R1 "R" at (200,300) #amber
resistor:R2 "R" at (600,300) #amber
R1.out -> R2.in #amber [ortho]
R1.r -> R2.left #amber [ortho]`,
			fence
		);
		expect(inspectSchematic(document).diagnostics.map((one) => one.code)).toContain(
			'duplicate-connection'
		);
	});

	test('reports canonical terminals through the source map and full-mode markup', () => {
		const compiled = compileSchematic(
			`resistor:R1 "R" at (200,300) #amber
port:A "A" at (600,300) #blue
R1.r -> A.in #amber [ortho]`,
			{ ...fence, mode: 'full', idPrefix: 'canonical' }
		);
		expect(compiled.sourceMap.wires[0]!.source).toBe('R1.out');
		expect(compiled.svg).toContain('data-wire-source="R1.out"');
	});
});

describe('generated geometry serializes at the documented precision', () => {
	/*
	 * Integrated-circuit pins interpolated raw JavaScript numbers while every
	 * other vector went through the three-decimal serializer, so a pin count that
	 * divides badly emitted seventeen significant digits — and a stub end that
	 * disagreed with the routed port point below the third decimal.
	 */
	test.each([3, 5, 6, 7, 9, 11, 13])('keeps a %i-pin chip within three decimals', (pins) => {
		const side = (prefix: string): string =>
			Array.from({ length: pins }, (_, index) => `${prefix}${index}`).join(',');
		const { svg } = compileSchematic(
			`ic:U1 "MCU" at (500,350) #slate [left="${side('l')}" top="${side('t')}"]`,
			{ ...fence, idPrefix: 'chip' }
		);
		expect(emittedNumbers(svg).length).toBeGreaterThan(0);
		for (const number of emittedNumbers(svg)) {
			expect(number.split('.')[1]!.length).toBeLessThanOrEqual(3);
		}
	});

	test('lands a wire exactly on the pin stub it joins', () => {
		const { svg } = compileSchematic(
			`ic:U1 "MCU" at (400,350) #slate [right="a,b,c,d,e,f"]
port:P "P" at (900,350) #blue
U1.a -> P.in #blue [ortho]`,
			{ ...fence, idPrefix: 'stub' }
		);
		/*
		 * The chip draws its pins in local coordinates and the router places the
		 * wire in absolute ones. Seven pins over a body height that does not divide
		 * by seven is exactly where a raw JavaScript number and a three-decimal one
		 * part company, so the two must still agree once the group transform is
		 * applied.
		 */
		const stubY = Number(/schematic-token--slate" d="M 44 (-?[\d.]+) H 60"/.exec(svg)![1]);
		const [, traceX, traceY] = /class="[^"]*schematic-trace[^"]*" d="M ([\d.]+) (-?[\d.]+)/.exec(
			svg
		)!;
		expect(Number(traceX)).toBe(400 + 60);
		expect(Number(traceY)).toBe(Number((350 + stubY).toFixed(3)));
	});
});

describe('a document is not capped at a component count', () => {
	/*
	 * 512 components and 2,048 connections were arbitrary ceilings, and three
	 * other limits stood behind them: a 4,096-unit canvas that could not hold a
	 * thousand parts however many the parser allowed, a source-character cap that
	 * ran out at roughly three thousand declarations, and a 2 MiB output cap.
	 * Removing one without the others would have changed nothing a user could see.
	 */
	const grid = (count: number, wired: boolean) => {
		const columns = Math.ceil(Math.sqrt(count * 1.6));
		const lines: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const x = 60 + (index % columns) * 110;
			const y = 60 + Math.floor(index / columns) * 100;
			lines.push(`resistor:R${index} "R" at (${x},${y}) #amber`);
		}
		if (wired) {
			for (let index = 0; index + 1 < count; index += 2) {
				if (Math.floor(index / columns) !== Math.floor((index + 1) / columns)) continue;
				lines.push(`R${index}.out -> R${index + 1}.in #amber [ortho]`);
			}
		}
		return {
			source: lines.join('\n'),
			bounds: {
				width: 120 + columns * 110,
				height: 160 + Math.ceil(count / columns) * 100
			}
		};
	};

	test.each([600, 2_000])('compiles %i components, past the old 512 ceiling', (count) => {
		const { source, bounds } = grid(count, false);
		const { document, svg } = compileSchematic(source, {
			bounds,
			title: 'Large document',
			idPrefix: 'large'
		});
		expect(document.components).toHaveLength(count);
		expect(svg.match(/class="schematic-component"/g)).toHaveLength(count);
	});

	test('compiles more connections than the old 2,048 ceiling', () => {
		const { source, bounds } = grid(6_000, true);
		const { document } = compileSchematic(source, {
			bounds,
			title: 'Large document',
			idPrefix: 'large'
		});
		expect(document.connections.length).toBeGreaterThan(2_048);
	});

	test('accepts a canvas past the old 4,096-unit ceiling', () => {
		const { document } = compileSchematic('resistor:R1 "R" at (5000,5000) #amber', {
			bounds: { width: 10_000, height: 10_000 },
			title: 'Wide canvas'
		});
		expect(document.components).toHaveLength(1);
	});

	test('keeps the spatial hash exact on a canvas no 4,096 stride would survive', () => {
		/*
		 * Cell keys are `column * stride + row`. The old stride assumed 64 cells per
		 * axis; two traces this far apart would have collided into one bucket and
		 * been compared as though they touched.
		 */
		const { svg } = compileSchematic(
			`port:A "A" at (200,200) #blue
port:B "B" at (60000,200) #blue
port:C "C" at (200,60000) #cyan
port:D "D" at (60000,60000) #cyan
A.out -> B.in #blue [ortho]
C.out -> D.in #cyan [ortho]`,
			{ bounds: { width: 61_000, height: 61_000 }, title: 'Far apart', idPrefix: 'far' }
		);
		expect(svg.match(/schematic-trace/g)).toHaveLength(2);
		expect(svg).not.toContain(' A ');
	});

	test.each([
		['components', 3, /exceeds the 3 component limit/],
		['connections', 2, /exceeds the 2 connection limit/],
		['sourceCharacters', 40, /exceeds the 40 character limit/]
	])('enforces a caller-supplied %s budget', (name, limit, message) => {
		const source = `resistor:R0 "R" at (100,120) #amber
resistor:R1 "R" at (300,120) #amber
resistor:R2 "R" at (500,120) #amber
resistor:R3 "R" at (700,120) #amber
R0.out -> R1.in #amber [ortho]
R1.out -> R2.in #amber [ortho]
R2.out -> R3.in #amber [ortho]`;
		expect(() => compileSchematic(source, { ...fence, limits: { [name]: limit } })).toThrow(
			message
		);
		/* The same document with no budget is fine, so the limit did the rejecting. */
		expect(() => compileSchematic(source, fence)).not.toThrow();
	});

	test('enforces a caller-supplied output byte budget', () => {
		const source = 'resistor:R1 "R" at (300,300) #amber';
		expect(() => compileSchematic(source, { ...fence, limits: { svgOutputBytes: 256 } })).toThrow(
			/exceeds the 256 byte output limit/
		);
		expect(() =>
			compileSchematic(source, { ...fence, limits: { svgOutputBytes: 268_435_456 } })
		).not.toThrow();
	});

	test('enforces a caller-supplied wire-crossing budget', () => {
		const source = `port:L0 "L" at (60,300) #blue
port:R0 "R" at (900,300) #blue
port:T0 "T" at (300,120) #cyan [orientation=down]
port:B0 "B" at (300,560) #cyan [orientation=up]
port:T1 "T" at (500,120) #cyan [orientation=down]
port:B1 "B" at (500,560) #cyan [orientation=up]
L0.out -> R0.in #blue [ortho]
T0.out -> B0.in #cyan [ortho]
T1.out -> B1.in #cyan [ortho]`;
		expect(() => compileSchematic(source, { ...fence })).not.toThrow();
		expect(() => compileSchematic(source, { ...fence, limits: { wireCrossings: 1 } })).toThrow(
			/Wire crossing complexity exceeds 1 intersections/
		);
	});

	test('rejects a malformed budget instead of ignoring it', () => {
		const source = 'resistor:R1 "R" at (300,300) #amber';
		for (const limits of [7, 'tight', null] as unknown[]) {
			expect(() =>
				compileSchematic(source, { ...fence, limits: limits as never })
			).toThrow(/limits must be an object/);
		}
		/* A misspelled field is the dangerous case: silently ignoring it leaves a
		   host believing it set a ceiling it never set. */
		expect(() =>
			compileSchematic(source, { ...fence, limits: { component: 4 } as never })
		).toThrow(/Unknown compiler limit component\./);
		for (const limit of [0, -1, 1.5, Number.NaN, '4', -Number.POSITIVE_INFINITY]) {
			expect(() =>
				compileSchematic(source, { ...fence, limits: { components: limit as never } })
			).toThrow(/must be a positive integer or Infinity/);
		}
	});

	test('reads Infinity as no limit, and omission as the default', () => {
		const source = Array.from(
			{ length: 40 },
			(_, index) => `resistor:R${index} "R" at (${80 + (index % 8) * 110},${80 + Math.floor(index / 8) * 120}) #amber`
		).join('\n');
		const wide = { bounds: { width: 1000, height: 800 }, title: 'Budget' };
		expect(() =>
			compileSchematic(source, { ...wide, limits: { components: Number.POSITIVE_INFINITY } })
		).not.toThrow();
		expect(() => compileSchematic(source, { ...wide, limits: {} })).not.toThrow();
		expect(() => compileSchematic(source, { ...wide, limits: { components: 39 } })).toThrow(
			/39 component limit/
		);
	});

	test('resolves a budget once, so a getter cannot move it between passes', () => {
		/*
		 * The same defence the fence's bounds and title get. A budget read where it
		 * is enforced could be generous to the parser and mean to the renderer, or
		 * the reverse, and the document would be validated against neither.
		 */
		let reads = 0;
		const volatile = {
			get components() {
				reads += 1;
				return reads === 1 ? 4 : 1;
			}
		} as unknown as SchematicLimitOptions;
		const source = `resistor:R0 "R" at (100,120) #amber
resistor:R1 "R" at (300,120) #amber`;
		expect(() => compileSchematic(source, { ...fence, limits: volatile })).not.toThrow();
		expect(reads).toBe(1);
	});

	test('defaults to no component or connection ceiling at all', () => {
		expect(SCHEMATIC_LIMITS).toEqual({
			minimumBound: 64,
			maximumBound: 1_048_576,
			components: Number.POSITIVE_INFINITY,
			connections: Number.POSITIVE_INFINITY,
			sourceCharacters: 16_777_216,
			wireCrossings: 32_768,
			svgOutputBytes: 268_435_456,
			placementDepth: 64,
			routingAttempts: 12
		});
		expect(Object.isFrozen(SCHEMATIC_LIMITS)).toBe(true);
	});
});

describe('a terminal cannot be wired to itself', () => {
	/*
	 * `R1.in -> R1.in` compiled to `d="M 158 200 H 158"` — a wire that paints
	 * nothing, carries a label nobody can see, and adds a one-terminal net to the
	 * netlist. Aliases made it easy to write by accident: on a MOSFET, `emitter`
	 * and `source` are the same lead.
	 */
	test.each(['line', 'bezier', 'ortho'])('rejects a self-connection routed as %s', (curve) => {
		expect(() =>
			parseSchematic(
				`resistor:R1 "R" at (300,300) #amber\nR1.in -> R1.in #amber [${curve}]`,
				fence
			)
		).toThrow('Line 2: R1.in cannot connect to itself; a connection needs two distinct terminals.');
	});

	test('rejects a self-connection disguised by two spellings of one lead', () => {
		expect(() =>
			parseSchematic(
				`transistor:Q1 "Q" at (300,300) #amber [type=nmos]\nQ1.emitter -> Q1.source #amber`,
				fence
			)
		).toThrow(/Q1\.source cannot connect to itself/);
		expect(() =>
			parseSchematic(
				`resistor:R1 "R" at (300,300) #amber\nR1.out -> R1.r #amber`,
				fence
			)
		).toThrow(/R1\.out cannot connect to itself/);
	});

	test('still measures a degenerate route handed straight to the layout API', () => {
		/*
		 * `parseSchematic` now rejects a self-connection, but `routeConnections` is
		 * exported and takes no parser provenance, so a host assembling its own AST
		 * can still present one. Nothing downstream may divide by the zero length
		 * that produces.
		 */
		const port: SchematicComponent = {
			kind: 'port',
			id: 'P',
			label: 'P',
			x: 300,
			y: 300,
			color: { kind: 'token', value: 'blue' },
			line: 1
		};
		const degenerate: SchematicConnection = {
			from: { componentId: 'P', port: 'in' },
			to: { componentId: 'P', port: 'in' },
			color: { kind: 'token', value: 'blue' },
			curve: 'line',
			markerStart: 'none',
			markerEnd: 'none',
			label: 'loop',
			line: 1
		};
		const routes = routeConnections([degenerate], new Map([['P', port]]));
		expect(routes[0]!.d).toBe('M 258 300 L 258 300');
		expect(connectionLabelPoint(routes[0]!)).toEqual({ x: 258, y: 300 });
	});

	test('still accepts the two distinct leads of one component', () => {
		const document: SchematicDocument = parseSchematic(
			`resistor:R1 "R" at (300,300) #amber\nR1.l -> R1.right #amber`,
			fence
		);
		expect(document.connections[0]).toMatchObject({
			from: { componentId: 'R1', port: 'in' },
			to: { componentId: 'R1', port: 'out' }
		});
	});
});

describe('routing report', () => {
	test('lists congestion cells column by column, then row by row', () => {
		const source = `port:A "A" at (80,100) #blue
port:B "B" at (520,300) #blue [orientation=left]
port:C "C" at (80,300) #cyan
port:D "D" at (520,100) #cyan [orientation=left]
A.out -> B.in #blue [ortho]
C.out -> D.in #cyan [ortho]`;
		const { routing } = compileSchematic(source, { bounds: { width: 640, height: 400 }, title: 'congestion' });
		expect(routing.congestion.length).toBeGreaterThan(4);
		const sorted = [...routing.congestion].sort((left, right) => left.x - right.x || left.y - right.y);
		expect(routing.congestion).toEqual(sorted);
		expect(new Set(routing.congestion.map((cell) => cell.x)).size).toBeGreaterThan(1);
	});
});

describe('free pins', () => {
	test('no routed wire passes through a pin nothing is wired to', () => {
		/* C's top pin is free. Running along C's body edge is legal, but that edge
		   holds the pin, and a wire over it would read as joined to it. */
		const source = `port:A "A" at (70,100) #blue
junction:J "junction" at (260,100) #cyan
port:B "B" at (450,100) #blue [orientation=left]
port:C "C" at (260,210) #cyan [orientation=up]
A.out -> J.node #blue [ortho]
J.node -> B.in #blue [ortho]
J.node -> C.in #cyan [ortho]`;
		const document = parseSchematic(source, { bounds: { width: 900, height: 540 }, title: 'free pins' });
		const free = resolvePortPoint(document.components.find((component) => component.id === 'C')!, 'out');
		const routes = routeConnections(document.connections, new Map(document.components.map((component) => [component.id, component])), { width: 900, height: 540 });
		for (const route of routes) {
			for (let step = 1; step < route.points.length; step += 1) {
				const [a, b] = [route.points[step - 1]!, route.points[step]!];
				const through = Math.min(a.x, b.x) <= free.x && free.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= free.y && free.y <= Math.max(a.y, b.y);
				expect(through, `${route.d}`).toBe(false);
			}
		}
	});
});

describe('found by the layout property search', () => {
	const traces = (svg: string) => [...svg.matchAll(/schematic-trace[^"]*" d="([^"]*)"/g)].map((match) => match[1]!);

	test('a connection written twice is crossed once, not twice at one point', () => {
		/* The repeat is drawn along the first; counting its copper as a second
		   crossing put two bridge arcs at one point and failed the document. */
		const result = compileSchematic(
			`switch:C0 "V_{out}" at (160, 460) #amber [type=spdt orientation=left]
mux:C1 "Q" at (580, 220) #blue [inputs=4 orientation=up]
cnot:C2 "Load" at (600, 720) #amber
port:C3 "1 k\\Omega" at (280, 540) #amber [orientation=right]
amplifier:C4 "1 k\\Omega" at (660, 640) #cyan [type=opamp orientation=down]
ground:C5 "R" at (520, 420) #cyan
testpoint:C6 "V_{out}" at (500, 600) #amber
C1.enable -> C3.in #blue [ortho]
C0.common -> C1.in1 #blue [ortho]
C3.out -> C1.in4 #blue [bezier]
C4.v+ -> C6.node #blue [ortho net=N1]
C4.v+ -> C6.node #blue [ortho]`,
			{ bounds: { width: 800, height: 850 }, title: 'repeat', mode: 'full' }
		);
		const [, , , repeatedA, repeatedB] = traces(result.svg);
		expect(repeatedA).toBe(repeatedB);
	});

	test('two connectors between the same sides are drawn apart, whichever is written first', () => {
		const lines = ['testpoint:C0 "Q" at (440, 140) #amber', 'class:C1 "1 k\\Omega" at (500, 280) #cyan', 'class:C2 "1 k\\Omega" at (360, 200) #slate'];
		const forward = 'C2.left -> C1.right #blue [ortho association]';
		const backward = 'C1.right -> C2.left #blue [ortho association]';
		const fence = { bounds: { width: 600, height: 400 }, title: 'pair', mode: 'full' } as const;
		const one = compileSchematic([...lines, forward, backward].join('\n'), fence);
		const other = compileSchematic([...lines, backward, forward].join('\n'), fence);
		const [a, b] = traces(one.svg);
		expect(a).not.toBe(b);
		expect(traces(other.svg).sort()).toEqual([a, b].sort());
	});

	test('the same connector written twice is drawn twice, apart', () => {
		const result = compileSchematic(
			'class:C1 "A" at (500, 280) #cyan\nclass:C2 "B" at (200, 200) #slate\nC2.right -> C1.left #blue [ortho association]\nC2.right -> C1.left #blue [ortho association]',
			{ bounds: { width: 700, height: 400 }, title: 'twice', mode: 'full' }
		);
		const [a, b] = traces(result.svg);
		expect(a).not.toBe(b);
	});

	test('a bridge stops short of a junction on its own run', () => {
		const result = compileSchematic(
			`flipflop:C0 "Microcontroller" at (420, 280) #amber [type=d orientation=down]
transistor:C1 "x" at (560, 280) #cyan [type=npn]
action:C2 "Q" at (660, 120) #cyan
amplifier:C3 "x" at (960, 320) #amber [type=opamp orientation=left]
port:C4 "Q" at (1020, 480) #cyan
resistor:C5 "1 k\\Omega" at (600, 440) #cyan [orientation=down]
mux:C6 "Q" at (100, 560) #blue [inputs=4]
C1.base -> C5.in #blue [ortho]
C3.v+ -> C4.in #blue [ortho net=N0]
C1.emitter -> C4.in #blue [ortho]
C1.base -> C6.select #blue [ortho]
C3.positive -> C6.in1 #blue [ortho]
C0.d -> C4.in #blue [ortho label="bus"]
C5.in -> C4.out #blue [ortho label="bus"]`,
			{ bounds: { width: 1200, height: 850 }, title: 'short bridge', mode: 'full' }
		);
		/* The junction sits at y = 372 on the run x = 482; the arc over y = 368
		   ends a whole unit before it, so the dot lands on copper. */
		expect(traces(result.svg)).toContain('M 518 280 H 482 V 365 A 3 3 0 0 0 482 371 V 648 H 86 V 618');
		expect(result.svg).toContain('cx="482" cy="372"');
	});

	test('a lead that runs into another part\'s free pin is named', () => {
		expect(() =>
			compileSchematic(
				`not:C0 "Sensor input" at (280, 440) #cyan
ic:C1 "V_{out}" at (280, 320) #cyan [left="A,B,C" right="Y,Z"]
nand:C2 "Microcontroller" at (160, 320) #cyan
C2.out1 -> C1.Y #blue [ortho]`,
				{ bounds: { width: 1400, height: 700 }, title: 'free pin' }
			)
		).toThrow('Line 4: C2.out1 sits against C1.B, which nothing is wired to: the wire leaving C2.out1 would read as joined to it. Move one of them away, or wire C1.B.');
	});

	test('a wire never runs through a pin of its own net to reach the tree', () => {
		/* Entering same-net copper away from the joint is charged like a
		   crossing; free, the second wire ran straight up through C0.negative. */
		const result = compileSchematic(
			`source:C0 "V_{out}" at (260, 240) #slate [type=voltage-dc]
hadamard:C1 "Q" at (360, 180) #blue
diode:C2 "V_{out}" at (220, 80) #slate [orientation=right]
C1.out -> C2.anode #blue [ortho]
C0.positive -> C2.cathode #blue [ortho]
C2.cathode -> C0.negative #blue [ortho]`,
			{ bounds: { width: 1200, height: 400 }, title: 'own pin', mode: 'full' }
		);
		expect(traces(result.svg)[1]).toBe('M 302 240 H 314 V 312 H 192 V 228 H 206');
	});

	test('a lead that runs into its partner from the side is named, not reported as unroutable', () => {
		expect(() =>
			compileSchematic(
				`class:C0 "Microcontroller" at (880, 260) #amber
not:C1 "x" at (400, 260) #blue [orientation=right]
source:C2 "V_{out}" at (500, 280) #slate [type=voltage-dc]
C2.positive -> C1.out1 #blue [ortho]`,
				{ bounds: { width: 1000, height: 400 }, title: 'partner' }
			)
		).toThrow('Line 4: C1.out1 sits against C2: the wire leaving it would run straight through C2. Move one of them away.');
	});

	test('of two equal connections, the one whose growing end may join is drawn as the branch', () => {
		/* The arrowed copy may still join the tree at its plain end, so it is
		   the one grown from the copper the net already has. */
		const result = compileSchematic(
			`port:C0 "R" at (740, 540) #blue [orientation=up]
port:C2 "1 k\\Omega" at (640, 80) #blue
and:C4 "Q" at (920, 560) #slate [inputs=3]
C4.in1 -> C2.out #blue [ortho label="bus"]
C4.in1 -> C0.out #blue [ortho arrow]
C4.in1 -> C0.out #blue [ortho]`,
			{ bounds: { width: 1200, height: 850 }, title: 'branch', mode: 'full' }
		);
		expect(traces(result.svg)).toEqual(['M 872 548 H 770 V 80 H 682', 'M 770 472 H 740 V 498', 'M 872 548 H 770 V 472 H 740 V 498']);
	});

	test('a wire crossing its own net is dotted at each crossing, in either render mode', () => {
		const source = `port:A "A" at (100, 160) #amber
port:B "B" at (650, 160) #amber
port:C "C" at (100, 260) #amber
port:D "D" at (650, 260) #amber
port:T "T" at (350, 80) #amber [orientation=down]
port:U "U" at (350, 360) #amber [orientation=up]
A.out -> B.in #blue [ortho net=N]
C.out -> D.in #blue [ortho net=N]
T.out -> U.out #blue [ortho net=N]`;
		const bounds = { width: 750, height: 440 };
		const full = compileSchematic(source, { bounds, title: 'dots', mode: 'full' }).svg;
		expect(traces(full)).toEqual(['M 142 160 H 608', 'M 142 260 H 608', 'M 350 122 V 318']);
		expect(full.match(/schematic-junction" fill="currentColor" cx="350" cy="(160|260)"/g)).toHaveLength(2);
		const compact = compileSchematic(source, { bounds, title: 'dots' }).svg;
		expect(compact).toContain('M 347 160 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0 M 347 260 a 3 3 0 1 0 6 0');
	});

	test('a wire never reaches its pin by running along the pin\'s own lead', () => {
		/* Its lead's nodes are closed to the search, not merely charged: priced,
		   the third wire ran along C1's edge through C1.common and looped back. */
		const result = compileSchematic(
			`measure:C0 "x" at (520, 120) #blue
switch:C1 "Microcontroller" at (180, 180) #amber [type=spdt orientation=up]
measure:C3 "Sensor input" at (260, 200) #blue [orientation=left]
C1.normally-closed -> C0.out #blue [ortho net=N0]
C3.in -> C1.common #blue [ortho]
C3.out -> C1.common #blue [ortho]`,
			{ bounds: { width: 1200, height: 400 }, title: 'lead', mode: 'full' }
		);
		expect(traces(result.svg)[2]).toBe('M 220 200 H 200 V 96 H 132 V 250 H 180 V 222');
	});
});

describe('junction parts', () => {
	const traces = (svg: string) => [...svg.matchAll(/schematic-trace[^"]*" d="([^"]*)"/g)].map((match) => match[1]!);

	test('wires written to a junction meet at it, straight, from any side', () => {
		/* A junction's node was a pin with a lead pointing left and a no-branch
		   ring around it, so only one wire reached it and the rest tapped that
		   one nearby, with dots of their own. */
		const result = compileSchematic(
			`resistor:R1 "a" at (200, 160) #amber
junction:N1 "N" at (360, 160) #amber
resistor:R2 "b" at (520, 160) #amber
capacitor:C1 "c" at (360, 280) #cyan [orientation=down]
R1.out -> N1.node #amber [ortho]
N1.node -> R2.in #amber [ortho]
N1.node -> C1.in #amber [ortho]`,
			{ bounds: { width: 700, height: 400 }, title: 'tee', mode: 'full' }
		);
		expect(traces(result.svg)).toEqual(['M 242 160 H 360', 'M 360 160 H 478', 'M 360 160 V 238']);
		expect(result.svg).not.toContain('schematic-junction');
	});

	test('a junction sets its text beside the dot, clear of all four exits', () => {
		const source = 'junction:N1 "V_{x}" at (300, 200) #amber';
		const [component] = parseSchematic(source, fence).components;
		expect(componentTextAnchors(component!)).toMatchObject({ designatorY: -27, labelY: -10, textX: 10 });
		for (const mode of ['full', 'default'] as const) {
			const svg = compileSchematic(source, { ...fence, mode }).svg;
			expect(svg).toContain('<text class="schematic-designator" x="10" y="-27" style="text-anchor:start">N1</text>');
			expect(svg).toMatch(/<text class="schematic-label" x="10" y="-10" style="text-anchor:start">/);
		}
		/* The text counts against the fence on the side it now sits. */
		expect(() => parseSchematic('junction:N1 "V_{out}" at (980, 200) #amber', fence)).toThrow(
			'Line 1: N1 geometry exceeds the declared 1000x700 bounds: extends 14 past x=1000; move N1 to x <= 966.'
		);
		/* Other parts keep their centred rows. */
		expect(compileSchematic('resistor:R1 "r" at (300, 200) #amber', fence).svg).toContain('<text class="schematic-designator" x="0" y="-28">R1</text>');
	});

	test('another net never runs through a junction\'s dot', () => {
		/* The junction's clearance ring gives way to C0.source, whose exit sits
		   inside it; the dot itself still keeps the wire out. */
		const result = compileSchematic(
			`transistor:C0 "Q" at (220, 280) #cyan [type=nmos]
junction:C2 "V_{out}" at (280, 300) #blue
switch:C3 "S" at (460, 380) #blue [type=spdt]
C3.normally-closed -> C0.source #blue [ortho]`,
			{ bounds: { width: 800, height: 550 }, title: 'dot', mode: 'full' }
		);
		expect(traces(result.svg)).toEqual(['M 502 392 H 514 V 305 H 275 V 302 H 262']);
	});

	test('an amplifier with a feedback divider through junctions routes', () => {
		/* Unroutable before: every wire at FB had to leave it leftwards through
		   its own text. */
		const result = compileSchematic(
			`source:VIN "V_{in}" at (100, 230) #blue [type=voltage-ac orientation=up]
resistor:R1 "10 k\\Omega" at (240, 160) #amber
junction:N1 "V_{c}" at (360, 160) #amber
capacitor:C1 "1 nF" at (360, 260) #cyan [orientation=down]
amplifier:U1 "OPA" at (560, 173) #purple [type=opamp]
junction:FB "V_{fb}" at (460, 290) #purple
resistor:RF "100 k\\Omega" at (620, 290) #amber
resistor:RG "10 k\\Omega" at (460, 360) #amber [orientation=down]
junction:VOUT "V_{out}" at (740, 173) #emerald
ground:G "0 V" at (360, 460) #slate
VIN.positive -> R1.in #blue [ortho]
R1.out -> N1.node #amber [ortho]
N1.node -> U1.positive #amber [ortho]
N1.node -> C1.in #cyan [ortho]
U1.negative -> FB.node #purple [ortho]
FB.node -> RF.in #purple [ortho]
RF.out -> VOUT.node #emerald [ortho]
U1.out -> VOUT.node #emerald [ortho]
FB.node -> RG.in #purple [ortho]
RG.out -> G.in #slate [ortho]
C1.out -> G.in #slate [ortho]
VIN.negative -> G.in #slate [ortho]`,
			{ bounds: { width: 840, height: 540 }, title: 'filter', mode: 'full' }
		);
		expect(traces(result.svg).slice(2, 9)).toEqual(['M 360 160 H 512', 'M 360 160 V 218', 'M 512 186 H 460 V 290', 'M 460 290 H 578', 'M 662 290 H 740 V 173', 'M 608 173 H 740', 'M 460 290 V 318']);
	});
});
