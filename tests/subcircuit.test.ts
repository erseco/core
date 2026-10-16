/**
 * Sub-circuits: a block written once and placed many times.
 *
 * They are lowered to ordinary declarations before anything reads the document,
 * so the property everything else rests on is the first one tested here: an
 * instance compiles to exactly the declarations it stands for. The rest pins the
 * naming, offsetting and parameter rules that expansion applies, and the
 * diagnostics that keep a mistake in a block from surfacing as a confusing error
 * about some prefixed id far from the line that caused it.
 */
import { describe, expect, test } from 'vitest';

import { compileSchematic, parseSchematic } from '../src/index.js';
import type { SchematicDocument } from '../src/types.js';

const FENCE = { bounds: { width: 800, height: 500 }, title: 'subcircuit' } as const;

const DIVIDER = `subcircuit divider [top="10 k" bottom="10 k"] {
  // two resistors in series
  resistor:RT "{{top}}" at (0, 0) #amber [orientation=down]
  resistor:RB "{{bottom}}" below RT by 40 #amber [orientation=down]
  RT.out -> RB.in #amber [ortho]
  expose top = RT.in
  expose mid = RT.out
  expose gnd = RB.out
}
`;

/** Components and connections without the line numbers expansion deliberately keeps. */
function shape(document: SchematicDocument) {
	return {
		components: document.components.map(({ line: _line, ...component }) => component),
		connections: document.connections.map(({ line: _line, ...connection }) => connection)
	};
}

describe('expansion', () => {
	test('an instance compiles to exactly the declarations it stands for', () => {
		const expanded = parseSchematic(
			`${DIVIDER}divider:U1 at (200, 100)\ndivider:U2 at (500, 100) [bottom="4.7 k"]\nU1.mid -> U2.top #blue [ortho]`,
			FENCE
		);
		const flat = parseSchematic(
			[
				'resistor:U1_RT "10 k" at (200, 100) #amber [orientation=down]',
				'resistor:U1_RB "10 k" below U1_RT by 40 #amber [orientation=down]',
				'U1_RT.out -> U1_RB.in #amber [ortho]',
				'resistor:U2_RT "10 k" at (500, 100) #amber [orientation=down]',
				'resistor:U2_RB "4.7 k" below U2_RT by 40 #amber [orientation=down]',
				'U2_RT.out -> U2_RB.in #amber [ortho]',
				'U1_RT.out -> U2_RT.in #blue [ortho]'
			].join('\n'),
			FENCE
		);
		expect(shape(expanded)).toEqual(shape(flat));
	});

	test('copied declarations keep the definition line that wrote them', () => {
		const result = compileSchematic(`${DIVIDER}divider:U1 at (200, 100)`, FENCE);
		expect(result.sourceMap.nodes).toEqual([
			{ id: 'U1_RT', line: 3 },
			{ id: 'U1_RB', line: 4 }
		]);
		expect(result.sourceMap.wires.map((wire) => wire.line)).toEqual([5]);
		/* The placement evidence is the relative body line, re-pointed. */
		expect(result.placements).toEqual([
			expect.objectContaining({ id: 'U1_RB', line: 4, resolved: { x: 200, y: 270 } })
		]);
	});

	test('instances nest, offsets compose, and parameters reach colours and options', () => {
		const document = parseSchematic(
			[
				'subcircuit leg [tone=amber kind] {',
				'  resistor:R "leg" at (0, 0) #{{tone}} [type={{kind}}]',
				'  expose a = R.in',
				'  expose b = R.out',
				'}',
				'subcircuit pair {',
				'  leg:L at (0, 0) [kind=fixed]',
				'  leg:M at (0, 100) [tone=emerald kind="thermistor"]',
				'  L.b -> M.b #amber [ortho]',
				'  expose in = L.a',
				'}',
				'pair:P at (300, 150)',
				'source:V "V" at (100, 150) #blue',
				'V.positive -> P.in #blue [ortho]'
			].join('\n'),
			FENCE
		);
		expect(document.components.map((component) => [component.id, component.x, component.y, component.color.value])).toEqual([
			['P_L_R', 300, 150, 'amber'],
			['P_M_R', 300, 250, 'emerald'],
			['V', 100, 150, 'blue']
		]);
		expect(document.components[1]).toMatchObject({ passiveType: 'thermistor' });
		expect(
			document.connections.map((connection) => `${connection.from.componentId}.${connection.from.port}->${connection.to.componentId}.${connection.to.port}`)
		).toEqual(['P_L_R.out->P_M_R.out', 'V.positive->P_L_R.in']);
	});

	test('a part placed outside may measure from an instance terminal', () => {
		const document = parseSchematic(
			`${DIVIDER}divider:U1 at (200, 100)\nsource:V "V" at (60, 300) #blue\nport:P "P" right-of U1.mid by 100 aligned-y with V #blue`,
			FENCE
		);
		expect(document.components.at(-1)).toMatchObject({ id: 'P', y: 300 });
		expect(document.components.at(-1)!.x).toBeGreaterThan(300);
	});

	test('relations keep the terminals they measure from', () => {
		const expanded = parseSchematic(
			`${DIVIDER}divider:U1 at (200, 100)\nsubcircuit s {\n  resistor:A "a" at (0, 0) #amber\n  resistor:B "b" below A.out by 60 #amber\n}\ns:S at (500, 100)\nsource:V "V" at (60, 300) #blue\nport:P "P" right-of U1.mid by 100 aligned-y with V.positive #blue`,
			FENCE
		);
		const flat = parseSchematic(
			[
				'resistor:U1_RT "10 k" at (200, 100) #amber [orientation=down]',
				'resistor:U1_RB "10 k" below U1_RT by 40 #amber [orientation=down]',
				'U1_RT.out -> U1_RB.in #amber [ortho]',
				'resistor:S_A "a" at (500, 100) #amber',
				'resistor:S_B "b" below S_A.out by 60 #amber',
				'source:V "V" at (60, 300) #blue',
				'port:P "P" right-of U1_RT.out by 100 aligned-y with V.positive #blue'
			].join('\n'),
			FENCE
		);
		expect(shape(expanded)).toEqual(shape(flat));
	});

	test('a connection naming an instance on one side only is rewritten on that side', () => {
		const document = parseSchematic(`${DIVIDER}divider:U1 at (200, 100)\nground:G "0" at (500, 400) #slate\nU1.gnd -> G.in #slate [ortho]`, FENCE);
		expect(document.connections[1]).toMatchObject({
			from: { componentId: 'U1_RB', port: 'out' },
			to: { componentId: 'G', port: 'in' }
		});
	});

	test('a body line the parser cannot read is reported at that line', () => {
		expect(() =>
			parseSchematic('subcircuit bad {\n  this is not a declaration\n}\nbad:B at (100, 100)', FENCE)
		).toThrow('Line 2: Unrecognized schematic declaration.');
	});

	test('a body may only reach its own parts', () => {
		/* `R` is prefixed like every body id, so a reference out of the block
		   names a part that does not exist rather than a stray top-level one. */
		expect(() =>
			parseSchematic(
				'resistor:R "outer" at (100, 100) #amber\nsubcircuit s {\n  resistor:Q "q" right-of R #amber\n}\ns:S at (300, 300)',
				FENCE
			)
		).toThrow(/S_R/);
	});
});

describe('diagnostics', () => {
	const fails = (source: string) => () => parseSchematic(source, FENCE);
	const one = 'resistor:R "r" at (0, 0) #amber\n  expose a = R.in';

	test('definitions are well formed', () => {
		expect(fails(`subcircuit a {\nsubcircuit b {\n}\n}`)).toThrow(
			'Line 2: Subcircuit b is declared inside subcircuit a; close a with } first. Definitions do not nest, though instances may.'
		);
		expect(fails('subcircuit resistor {\n}')).toThrow(
			'Line 1: Subcircuit resistor would shadow the built-in resistor component; choose another name.'
		);
		expect(fails(`subcircuit a {\n${one}\n}\nsubcircuit a {\n}`)).toThrow(
			'Line 5: Subcircuit a is already declared on line 1.'
		);
		expect(fails(`subcircuit a {\n${one}`)).toThrow(
			'Line 1: Subcircuit a is never closed; end it with a line holding only }.'
		);
		expect(fails(`subcircuit a {\n${one}\n}\nresistor:X "x" at (100, 100) #amber`)).toThrow(
			'Line 1: Subcircuit a is declared but never placed; add a:ID at (x, y), or remove it.'
		);
	});

	test('instances are well formed', () => {
		const block = `subcircuit a [k="v"] {\n${one}\n}\n`;
		expect(fails(`${block}a:A "label" at (100, 100)`)).toThrow(
			'Line 5: Place subcircuit a as a:ID at (x, y), optionally followed by [name="value"]; an instance has no label or colour of its own.'
		);
		expect(fails(`${block}a:A at (100, 100)\na:A at (300, 100)`)).toThrow('Line 6: Duplicate component ID A.');
		expect(fails(`${block}a:A at (100, 100) [x="1"]`)).toThrow(
			'Line 5: Subcircuit a has no parameter x; it declares k.'
		);
		expect(fails(`subcircuit b {\n${one}\n}\nb:B at (100, 100) [x="1"]`)).toThrow('it declares none.');
		expect(fails(`subcircuit c [k] {\n${one}\n}\nc:C at (100, 100)`)).toThrow(
			'Line 5: C must set k: subcircuit c declares it without a default.'
		);
	});

	test('parameters are well formed', () => {
		const block = `subcircuit a [k="v"] {\n${one}\n}\n`;
		expect(fails(`${block}a:A at (100, 100) [k="1" k="2"]`)).toThrow('Line 5: Subcircuit parameter k is set twice.');
		expect(fails(`${block}a:A at (100, 100) [k]`)).toThrow('Line 5: Parameter k needs a value: k="...".');
		expect(fails(`${block}a:A at (100, 100) [k="1]`)).toThrow('Line 5: Subcircuit parameters have an unclosed quote.');
		expect(fails(`${block}a:A at (100, 100) [9k=1]`)).toThrow(
			'Line 5: Subcircuit parameters are written name="value"; 9k=1 is not one.'
		);
		expect(fails(`subcircuit a {\n  resistor:R "{{gain}}" at (0, 0) #amber\n}\na:A at (100, 100)`)).toThrow(
			'Line 2: {{gain}} is not a parameter of subcircuit a; declare it in the header as gain="default".'
		);
	});

	test('a subcircuit cannot contain itself', () => {
		expect(fails(`subcircuit a {\n  a:Inner at (0, 0)\n}\na:A at (100, 100)`)).toThrow(
			'Line 2: Subcircuit a contains itself through a -> a; a subcircuit cannot contain itself.'
		);
		expect(
			fails(`subcircuit a {\n  b:B at (0, 0)\n}\nsubcircuit b {\n  a:A at (0, 0)\n}\na:Top at (100, 100)`)
		).toThrow('Line 5: Subcircuit a contains itself through a -> b -> a; a subcircuit cannot contain itself.');
	});

	test('terminals are reached only through what a definition exposes', () => {
		expect(fails(`${DIVIDER}divider:U1 at (200, 100)\nexpose a = U1_RT.in`)).toThrow(
			'Line 11: expose only belongs inside a subcircuit definition.'
		);
		expect(fails(`subcircuit a {\n${one}\n  expose a = R.out\n}\na:A at (100, 100)`)).toThrow(
			'Line 4: Subcircuit a exposes a twice.'
		);
		expect(fails(`${DIVIDER}divider:U1 at (200, 100)\nresistor:X "x" at (600, 100) #amber\nU1.bias -> X.in #blue [ortho]`)).toThrow(
			'Line 12: U1 is a divider subcircuit, which exposes top, mid, gnd; it has no terminal bias.'
		);
		expect(
			fails(`subcircuit bare {\n  resistor:R "r" at (0, 0) #amber\n}\nbare:B at (200, 100)\nresistor:X "x" at (600, 100) #amber\nB.in -> X.in #blue [ortho]`)
		).toThrow('B is a bare subcircuit, which exposes no terminals; it has no terminal in.');
		expect(fails(`${DIVIDER}divider:U1 at (200, 100)\nport:P "P" right-of U1 #blue`)).toThrow(
			'Line 11: Place P relative to a terminal of U1, such as right-of U1.TERMINAL; a subcircuit instance has no body of its own to measure from.'
		);
	});

	test('an instance and a component cannot share a name', () => {
		expect(fails(`${DIVIDER}divider:U1 at (200, 100)\nresistor:U1 "x" at (600, 100) #amber`)).toThrow(
			'Line 11: U1 names both a component and a subcircuit instance; rename one of them.'
		);
	});

	test('expansion is held to the source character budget', () => {
		/* Three levels of eight instances is 512 resistors from fourteen lines. */
		const source = [
			'subcircuit leaf {\n  resistor:R "r" at (0, 0) #amber\n}',
			'subcircuit mid {',
			...Array.from({ length: 8 }, (_, index) => `  leaf:L${index} at (${index * 100}, 0)`),
			'}',
			'subcircuit top {',
			...Array.from({ length: 8 }, (_, index) => `  mid:M${index} at (0, ${index * 100})`),
			'}',
			...Array.from({ length: 8 }, (_, index) => `top:T${index} at (0, 0)`)
		].join('\n');
		expect(() =>
			parseSchematic(source, { ...FENCE, limits: { sourceCharacters: 4_000 } })
		).toThrow(
			'Line 2: Expanding subcircuits produces more than the 4,000 character source limit; place fewer instances, or raise limits.sourceCharacters.'
		);
	});
});
