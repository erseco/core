import { describe, expect, test } from 'vitest';
import {
	buildNetlist,
	compileSchematic,
	componentObstacleRectangle,
	parseSchematic,
	parseSchematicFence,
	renderSchematic,
	resolvePortGeometry,
	resolvePortPoint
} from '../src/index.js';

const fence = parseSchematicFence('schemd bounds="4096x4096" title="Primitive matrix"')!;

function grid(lines: readonly string[]): string {
	return lines
		.map((line, index) => {
			const x = 100 + (index % 20) * 190;
			const y = 100 + Math.floor(index / 20) * 170;
			return line.replace('(X,Y)', `(${x},${y})`);
		})
		.join('\n');
}

describe('phase-two primitive expansion', () => {
	test('parses and renders every electrical family through compact variants', () => {
		const declarations: string[] = [];
		for (const type of ['voltage-dc', 'voltage-ac', 'voltage-pulse', 'current-dc', 'current-ac', 'battery', 'vcvs', 'vccs', 'ccvs', 'cccs']) {
			declarations.push(`source:S${declarations.length} "${type}" at (X,Y) #blue [type=${type}]`);
		}
		for (const [kind, types] of [
			['resistor', ['fixed', 'variable', 'rheostat', 'potentiometer', 'thermistor', 'ldr']],
			['capacitor', ['fixed', 'variable', 'polarized']],
			['inductor', ['fixed', 'coupled', 'transformer']],
			['diode', ['standard', 'schottky', 'zener', 'led', 'photodiode', 'varactor', 'scr', 'triac']],
			['transistor', ['npn', 'pnp', 'nmos', 'pmos', 'njfet', 'pjfet', 'nigbt', 'pigbt']],
			['power', ['vcc', 'vdd', 'vss', 'positive', 'negative']],
			['switch', ['spst', 'spdt', 'pushbutton', 'relay']],
			['protection', ['fuse', 'breaker']],
			['amplifier', ['opamp', 'comparator', 'instrumentation']],
			['resonator', ['crystal', 'ceramic']],
			['meter', ['voltmeter', 'ammeter']],
			['load', ['lamp', 'motor', 'speaker', 'buzzer']]
		] as const) {
			for (const type of types) {
				declarations.push(`${kind}:E${declarations.length} "${type}" at (X,Y) #cyan [type=${type}]`);
			}
		}
		declarations.push('junction:J1 "node" at (X,Y) #amber');
		declarations.push('testpoint:TP1 "probe" at (X,Y) #amber');
		declarations.push('connector:C1 "terminal" at (X,Y) #amber [orientation=down]');
		const result = compileSchematic(grid(declarations), fence);
		expect(result.document.components).toHaveLength(declarations.length);
		expect(result.svg).not.toMatch(/NaN|Infinity|-0(?:\D|$)/);
	});

	test('draws the battery long plate on the positive terminal in every orientation', () => {
		for (const orientation of ['right', 'down', 'left', 'up'] as const) {
			const source = `source:B1 at (200,200) #blue [type=battery orientation=${orientation}]`;
			const { svg } = compileSchematic(source, fence);
			const symbol = /symbol-source-battery"><path [^>]* d="([^"]+)"/.exec(svg)![1]!;
			const plates = [...symbol.matchAll(/M (-?\d+) (-?\d+) V (-?\d+)/g)].map(([, x, top, bottom]) => ({ x: Number(x), height: Number(bottom) - Number(top) }));
			expect(plates).toHaveLength(2);
			const long = plates[0]!.height > plates[1]!.height ? plates[0]! : plates[1]!;
			const turn = (Number(/symbol-source-battery" transform="rotate\((-?\d+)\)"/.exec(svg)?.[1] ?? 0) * Math.PI) / 180;
			const plate = { x: long.x * Math.cos(turn), y: long.x * Math.sin(turn) };
			const positive = resolvePortPoint(parseSchematic(source, fence).components[0]!, 'positive')!;
			expect(plate.x * (positive.x - 200) + plate.y * (positive.y - 200)).toBeGreaterThan(0);
		}
	});

	test('draws source polarity marks towards their own terminals in every orientation and output mode', () => {
		const axes = { right: [1, 0], down: [0, 1], left: [-1, 0], up: [0, -1] } as const;
		const toward = (mark: { x: number; y: number }, terminal: { x: number; y: number }) => mark.x * terminal.x + mark.y * terminal.y;
		for (const type of ['voltage-dc', 'vcvs', 'ccvs', 'current-dc', 'vccs', 'cccs']) {
			const dependent = type.length === 4;
			const orientations = Object.keys(axes) as (keyof typeof axes)[];
			/* One document holds every orientation, so all four share one cached symbol. */
			const source = [
				...orientations.map((orientation, i) => `source:S${i} at (${200 + i * 300}, 200) #blue [type=${type} orientation=${orientation}]`),
				...orientations.map((orientation, i) => `testpoint:P${i} at (${200 + i * 300 + axes[orientation][0] * 90}, ${200 + axes[orientation][1] * 90}) #rose`),
				...orientations.map((_, i) => `S${i}.positive -> P${i}.node #rose`)
			].join('\n');
			const document = parseSchematic(source, fence);
			const nets = buildNetlist(document).nets.map((net) => net.terminals.map((end) => `${end.componentId}.${end.port}`).sort().join(' '));
			for (const mode of ['default', 'embedded-css', 'full'] as const) {
				const { svg } = compileSchematic(source, { ...fence, mode });
				const groups = svg.split('<g class="schematic-component"').slice(1);
				const symbol = new RegExp(`symbol-source-${type}">(.*?)</g>`).exec(svg)![1]!;
				expect(svg.match(/ id="[^"]*-symbol-/g)).toHaveLength(2);
				orientations.forEach((orientation, i) => {
					const [dx, dy] = axes[orientation];
					const centre = { x: 200 + i * 300, y: 200 };
					const at = (along: number, across = 0) => ({ x: centre.x + along * dx - across * dy, y: centre.y + along * dy + across * dx });
					const component = document.components[i]!;
					expect(resolvePortPoint(component, 'negative')).toEqual(at(-42));
					expect(resolvePortPoint(component, 'positive')).toEqual(at(42));
					expect(resolvePortPoint(component, 'in')).toEqual(at(-42));
					expect(resolvePortPoint(component, 'out')).toEqual(at(42));
					if (dependent) {
						expect(resolvePortPoint(component, 'control-positive')).toEqual(at(0, -34));
						expect(resolvePortPoint(component, 'control-negative')).toEqual(at(0, 34));
					}
					const half = dx === 0 ? { x: 46, y: 54 } : { x: 54, y: 46 };
					expect(componentObstacleRectangle(component)).toEqual({ minX: centre.x - half.x, minY: centre.y - half.y, maxX: centre.x + half.x, maxY: centre.y + half.y });
					expect(nets).toContain(`P${i}.node S${i}.positive`);
					if (mode === 'full') expect(svg).toMatch(new RegExp(`data-wire-source="S${i}\\.positive"[^>]*><path [^>]* d="M ${at(42).x} ${at(42).y} `));
					const group = groups.find((markup) => markup.includes(`translate(${centre.x} ${centre.y})`))!;
					const terminal = { positive: { x: dx, y: dy }, negative: { x: -dx, y: -dy } };
					if (type.startsWith('voltage') || type.endsWith('vs')) {
						/* Upright: the `+` is one horizontal and one vertical stroke, the `−` one horizontal stroke, outside the rotation. */
						const [, , plusY, , plusX, , , minusStart, minusY, minusEnd] = /d="M (-?\d+) (-?\d+) H (-?\d+) M (-?\d+) (-?\d+) V (-?\d+) M (-?\d+) (-?\d+) H (-?\d+)"/.exec(group)!.map(Number);
						expect(toward({ x: plusX!, y: plusY! }, terminal.positive)).toBeGreaterThan(0);
						expect(toward({ x: (minusStart! + minusEnd!) / 2, y: minusY! }, terminal.negative)).toBeGreaterThan(0);
						expect(symbol).not.toMatch(/ L -?\d+ -?\d+ -?\d+ -?\d+"/);
					} else {
						/* SPICE: positive current flows from `positive`, through the source, to `negative`. */
						const [, tipX, tipY] = /L (-?\d+) (-?\d+) -?\d+ -?\d+"/.exec(symbol)!.map(Number);
						const turn = (Number(/symbol-source-[^"]+"(?: transform="rotate\((-?\d+)\)")?/.exec(group)![1] ?? 0) * Math.PI) / 180;
						const tip = { x: tipX! * Math.cos(turn) - tipY! * Math.sin(turn), y: tipX! * Math.sin(turn) + tipY! * Math.cos(turn) };
						expect(toward(tip, terminal.negative)).toBeGreaterThan(0);
						expect(Math.abs(toward(tip, { x: -dy, y: dx }))).toBeLessThan(1e-9);
						expect(group).not.toMatch(/ H -?\d+ M -?\d+ -?\d+ V /);
					}
				});
			}
		}
	});

	test('uses exact quarter turns for vectors, ports, normals, hotspots, and bounds', () => {
		const document = parseSchematic(
			'resistor:R1 "rotated" at (200, 200) #amber [orientation=down]',
			fence
		);
		const resistor = document.components[0]!;
		expect(resolvePortPoint(resistor, 'in')).toEqual({ x: 200, y: 158 });
		expect(resolvePortGeometry(resistor, 'out')).toEqual({
			point: { x: 200, y: 242 },
			normal: { x: 0, y: 1 }
		});
		const svg = renderSchematic(document, { ...fence, mode: 'full' });
		expect(svg).toContain('transform="rotate(90)"');
		expect(svg).toContain('data-port-id="in"');
		expect(svg).toContain('cx="0" cy="-42"');
		expect(() => parseSchematic('junction:J1 "x" at (100, 100) #amber [orientation=up]', fence)).toThrow(/Option orientation/);
	});

	test('renders digital blocks, named quantum gates, track-aware structures, and UML nodes', () => {
		const declarations = [
			'xnor:XN "XNOR" at (X,Y) #cyan',
			'buffer:B1 "tri" at (X,Y) #cyan [type=tristate-inverter]',
			'logic:L1 "high" at (X,Y) #cyan [type=high]',
			'clock:CLK "clock" at (X,Y) #cyan',
			'flipflop:F1 "JK" at (X,Y) #cyan [type=jk]',
			'mux:M1 "mux" at (X,Y) #cyan [inputs=4]',
			'encoder:E1 "encoder" at (X,Y) #cyan',
			'decoder:D1 "decoder" at (X,Y) #cyan',
			'register:R1 "register" at (X,Y) #cyan [width=16]',
			'counter:C1 "counter" at (X,Y) #cyan',
			'adder:A1 "full" at (X,Y) #cyan [type=full]',
			'comparator:CMP "magnitude" at (X,Y) #cyan',
			'bus:BUS "split" at (X,Y) #cyan [type=splitter width=8 outputs=4]',
			...['xgate', 'ygate', 'zgate', 'sgate', 'sdg', 'tgate', 'tdg', 'sx', 'phase', 'rx', 'ry', 'rz', 'ugate'].map((kind, index) => `${kind}:Q${index} "${kind}" at (X,Y) #purple`),
			'measure:QM "measure" at (X,Y) #purple',
			'reset:QR "reset" at (X,Y) #purple',
			'prepare:QP "prepare" at (X,Y) #purple',
			'swap:QS "swap" at (X,Y) #purple [targets=2]',
			'control:QC "negative" at (X,Y) #purple [control=negative]',
			'toffoli:QT "toffoli" at (X,Y) #purple',
			'controlled:QG "multi" at (X,Y) #purple [controls=2 targets=2 operator="X"]',
			'barrier:QB "barrier" at (X,Y) #purple [wires=4]',
			'delay:QD "delay" at (X,Y) #purple [wires=3]',
			'classical-register:CR "c8" at (X,Y) #slate [width=8]',
			...['interface', 'provided-interface', 'required-interface', 'enumeration', 'datatype', 'object', 'component', 'component-port', 'artifact', 'node', 'device', 'execution', 'system', 'action', 'decision', 'merge', 'fork', 'join', 'activity-final', 'flow-final', 'object-node', 'send-signal', 'receive-signal', 'partition', 'activation', 'destruction', 'fragment', 'interaction', 'gate', 'found', 'lost', 'choice', 'state-junction', 'entry', 'exit', 'terminate', 'region'].map((kind, index) => `${kind}:U${index} "${kind}" at (X,Y) #slate`),
			'history:H1 "deep" at (X,Y) #slate [type=deep]'
		];
		const result = compileSchematic(grid(declarations), { ...fence, mode: 'full' });
		expect(result.document.components).toHaveLength(declarations.length);
		expect(result.svg).toContain('>H*</text>');
		expect(result.svg).toContain('data-port-id="control1"');
		expect(result.svg).not.toMatch(/NaN|Infinity/);
	});

	test('requires explicit compatible bus widths and distinguishes connection domains', () => {
		const source = `bus:B1 "bus" at (200, 200) #cyan [width=8]
port:P1 "port" at (500, 200) #cyan [width=8]
B1.bus -> P1.in #cyan [ortho width=8 signal=digital]`;
		const document = parseSchematic(source, fence);
		expect(document.connections[0]).toMatchObject({ width: 8, signalKind: 'digital' });
		expect(renderSchematic(document, { ...fence, mode: 'full' })).toContain('data-signal-kind="digital"');
		expect(() => parseSchematic(source.replace(' width=8 signal=digital', ' signal=digital'), fence)).toThrow(/explicit width/);
		expect(() => parseSchematic(source.replace('width=8 signal=digital', 'width=4 signal=digital'), fence)).toThrow(/incompatible/);
	});

	test('shares one polished shell between plain hadamard and qgate instances', () => {
		const svg = compileSchematic(
			'hadamard:H1 "Hadamard" at (150, 150) #purple\nqgate:Q1 "Custom" at (350, 150) #purple',
			fence
		).svg;
		expect(svg.match(/id="[^"]+-symbol-quantum-shell-50-50"/g)).toHaveLength(1);
		expect(svg.match(/href="#[^"]+-symbol-quantum-shell-50-50"/g)).toHaveLength(2);
	});

	test('ignores empty qgate detail rows so the shell never reserves blank text space', () => {
		const svg = compileSchematic(
			'hadamard:H1 "Hadamard" at (150, 150) #purple\nqgate:Q1 "Custom" at (350, 150) #purple [parameter=""]',
			fence
		).svg;
		expect(svg.match(/href="#[^"]+-symbol-quantum-shell-50-50"/g)).toHaveLength(2);
		expect(svg).not.toContain('quantum-shell-50-65');
	});

	test('collapses a single-wire barrier onto one centered quantum track', () => {
		const svg = compileSchematic('barrier:X "b" at (150, 150) #purple [wires=1]', fence).svg;
		expect(svg).toContain('d="M -42 0 H 42"');
		expect(svg.match(/H 42/g)).toHaveLength(1);
	});
});
