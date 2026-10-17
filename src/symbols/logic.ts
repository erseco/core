/**
 * Logic symbols: IEEE and IEC gates, and configurable digital blocks.
 *
 * @module
 */
import {
	ADDER_TYPES,
	BUFFER_TYPES,
	BUS_TYPES,
	FLIPFLOP_TYPES,
	LOGIC_STATES,
	MUX_TYPES,
	SchematicSyntaxError,
	type ClassicalGateComponent,
	type DigitalComponent
} from '../types.js';
import {
	colorAttributes,
	count,
	distributed,
	enumOption,
	indexed,
	n,
	only,
	orientation,
	TEXT_PAINT,
	u,
	width,
	type KindDef,
	type LocalPort
} from './common.js';

/** Gate height in diagram units: 16 per terminal on the busier side, at least 48. */
export function gateHeight(component: ClassicalGateComponent): number {
	return Math.max(48, Math.max(component.inputs, component.outputs) * 16);
}

function gatePort(component: ClassicalGateComponent, output: boolean, index: number): LocalPort {
	const total = output ? component.outputs : component.inputs;
	return {
		id: `${output ? 'out' : 'in'}${index + 1}`,
		x: output ? 48_000 : -48_000,
		y: distributed(index, total, gateHeight(component) * 1000),
		nx: output ? 1 : -1,
		ny: 0
	};
}

const OR_FAMILY = new Set(['or', 'nor', 'xor', 'xnor']);
const INVERTING = new Set(['nand', 'nor', 'xnor', 'not']);

/** Where a terminal stub meets the gate contour, in diagram units. */
function boundary(component: ClassicalGateComponent, output: boolean, y: number): number {
	if (component.standard === 'iec') return output ? 32 : -32;
	const half = gateHeight(component) / 2;
	if (!output) {
		if (OR_FAMILY.has(component.kind)) {
			const progress = (1 - y / half) / 2;
			return (component.kind === 'xor' || component.kind === 'xnor' ? -38 : -32) + 40 * progress * (1 - progress);
		}
		return component.kind === 'not' ? -30 : -32;
	}
	if (component.kind === 'and' || component.kind === 'nand') {
		const normalized = y / half;
		return 32 * Math.sqrt(Math.max(0, 1 - normalized * normalized));
	}
	if (OR_FAMILY.has(component.kind)) {
		const progress = Math.sqrt(Math.max(0, 1 - Math.abs(y) / half));
		const inverse = 1 - progress;
		return -32 * inverse * inverse + 6 * inverse * progress + 32 * progress * progress;
	}
	return 30 - 60 * (Math.abs(y) / half);
}

function gateStubs(component: ClassicalGateComponent, paint: string): string {
	const h = gateHeight(component) * 1000;
	let out = '';
	for (let index = 0; index < component.inputs; index += 1) {
		const y = distributed(index, component.inputs, h);
		out += `<path ${paint} d="M -48 ${n(y)} H ${u(boundary(component, false, y / 1000))}" />`;
	}
	for (let index = 0; index < component.outputs; index += 1) {
		const y = distributed(index, component.outputs, h);
		const start = boundary(component, true, y / 1000) + (INVERTING.has(component.kind) ? 8 : 0);
		out += `<path ${paint} d="M ${u(start)} ${n(y)} H 48" />`;
	}
	return out;
}

function bubbles(component: ClassicalGateComponent, paint: string): string {
	if (!INVERTING.has(component.kind)) return '';
	const h = gateHeight(component) * 1000;
	let out = '';
	for (let index = 0; index < component.outputs; index += 1) {
		const y = distributed(index, component.outputs, h);
		out += `<circle ${paint} cx="${u(boundary(component, true, y / 1000) + 4)}" cy="${n(y)}" r="4" />`;
	}
	return out;
}

const IEC_SYMBOLS: Readonly<Record<ClassicalGateComponent['kind'], string>> = {
	and: '&amp;', nand: '&amp;', or: '≥1', nor: '≥1', xor: '=1', xnor: '=1', not: '1'
};

const gate: KindDef<ClassicalGateComponent> = {
	parse(kind, common, options, line) {
		only(options, ['inputs', 'outputs', 'standard', 'orientation'], line);
		const standard = options.get('standard') ?? 'ieee';
		if (standard !== 'ieee' && standard !== 'iec') throw new SchematicSyntaxError('standard must be ieee or iec.', line);
		return {
			kind: kind as ClassicalGateComponent['kind'],
			...common,
			inputs: count(options.get('inputs'), kind === 'not' ? 1 : 2, 'inputs', line),
			outputs: count(options.get('outputs'), 1, 'outputs', line),
			standard,
			...orientation(options, line)
		};
	},
	extents: (component) => [48_000, gateHeight(component) * 500],
	ports(component) {
		const ports: LocalPort[] = [];
		for (let index = 0; index < component.inputs; index += 1) ports.push(gatePort(component, false, index));
		for (let index = 0; index < component.outputs; index += 1) ports.push(gatePort(component, true, index));
		return ports;
	},
	resolve(component, name) {
		const terminal = indexed(name, component.inputs, component.outputs);
		return terminal === undefined ? undefined : gatePort(component, terminal.output, terminal.index);
	},
	draw(component, paint) {
		const height = gateHeight(component);
		const top = -height / 2;
		const bottom = height / 2;
		if (component.standard === 'iec') {
			return `<rect ${paint} x="-32" y="${top}" width="64" height="${height}" rx="2" /><text class="schematic-gate-symbol" ${TEXT_PAINT} x="0" y="4" text-anchor="middle" font-size="14">${IEC_SYMBOLS[component.kind]}</text>${bubbles(component, paint)}${gateStubs(component, paint)}`;
		}
		let contour: string;
		if (component.kind === 'not') contour = `<path ${paint} d="M -30 ${top} L 30 0 L -30 ${bottom} Z" />`;
		else if (component.kind === 'and' || component.kind === 'nand') contour = `<path ${paint} d="M -32 ${top} H 0 A 32 ${bottom} 0 0 1 0 ${bottom} H -32 Z" />`;
		else {
			const xorArc = component.kind === 'xor' || component.kind === 'xnor' ? `<path ${paint} d="M -38 ${top} Q -18 0 -38 ${bottom}" />` : '';
			contour = `<path ${paint} d="M -32 ${top} Q 3 ${top} 32 0 Q 3 ${bottom} -32 ${bottom} Q -12 0 -32 ${top} Z" />${xorArc}`;
		}
		return `${contour}${bubbles(component, paint)}${gateStubs(component, paint)}`;
	}
};

/* ---- digital blocks ---- */

const DIGITAL_DEFAULTS: Readonly<Record<DigitalComponent['kind'], readonly [number, number]>> = {
	buffer: [1, 1], logic: [0, 1], clock: [0, 1], flipflop: [3, 2], mux: [2, 1],
	encoder: [4, 2], decoder: [2, 4], register: [3, 2], counter: [3, 2], adder: [2, 2],
	comparator: [2, 3], bus: [1, 2]
};

const DIGITAL_VARIANTS: Readonly<Partial<Record<DigitalComponent['kind'], readonly [string, readonly string[]]>>> = {
	buffer: ['plain', BUFFER_TYPES],
	logic: ['low', LOGIC_STATES],
	flipflop: ['d', FLIPFLOP_TYPES],
	mux: ['mux', MUX_TYPES],
	adder: ['half', ADDER_TYPES],
	bus: ['splitter', BUS_TYPES]
};

/**
 * Each side's terminals in drawing order: data inputs on the left, outputs on
 * the right, clock, enable and select below, preset and clear above. Every
 * terminal has its own slot, so no two distinct signals share a point.
 */
interface DigitalSides {
	readonly left: readonly string[];
	readonly right: readonly string[];
	readonly bottom: readonly string[];
	readonly top: readonly string[];
}

function digitalSides(component: DigitalComponent): DigitalSides {
	const range = (prefix: string, total: number) => Array.from({ length: total }, (_, index) => `${prefix}${index + 1}`);
	switch (component.kind) {
		case 'logic':
		case 'clock':
			return { left: [], right: ['out'], bottom: [], top: [] };
		case 'flipflop': {
			const variant = component.variant;
			return {
				left: variant === 'jk' ? ['j', 'k'] : variant === 't' ? ['t'] : variant === 'sr-latch' ? ['s', 'r'] : ['d'],
				right: ['q', 'nq'],
				bottom: variant === 'sr-latch' ? ['enable'] : ['clock'],
				top: variant === 'd' || variant === 't' ? ['preset', 'clear'] : ['preset']
			};
		}
		case 'register':
			/* A register's first data terminals are named `in` and `out`; any more
			   it is given are numbered on from 2. */
			return {
				left: ['in', ...range('in', component.inputs).slice(1)],
				right: ['out', ...range('out', component.outputs).slice(1)],
				bottom: ['clock', 'enable'],
				top: ['clear']
			};
		case 'comparator':
			return { left: ['in1', 'in2'], right: ['gt', 'eq', 'lt'], bottom: [], top: [] };
		case 'bus':
			return component.variant === 'tap'
				? { left: ['bus'], right: ['tap'], bottom: [], top: [] }
				: component.variant === 'joiner'
					? { left: range('in', component.inputs), right: ['bus'], bottom: [], top: [] }
					: { left: ['bus'], right: range('out', component.outputs), bottom: [], top: [] };
		default:
			return {
				left: range('in', component.inputs),
				right: range('out', component.outputs),
				bottom:
					component.kind === 'counter'
						? ['clock', 'enable']
						: component.kind === 'mux'
							? ['select', 'enable']
							: component.kind === 'buffer' && component.variant?.startsWith('tristate') === true
								? ['enable']
								: [],
				top: component.kind === 'counter' ? ['clear'] : []
			};
	}
}

/** Every terminal of a block, placed: left, right, bottom, then top. */
function digitalPorts(component: DigitalComponent): LocalPort[] {
	const { left, right, bottom, top } = digitalSides(component);
	const w = component.bodyWidth * 1000;
	const h = component.bodyHeight * 1000;
	const across = (names: readonly string[], x: number, nx: number) =>
		names.map((id, index) => ({ id, x, y: distributed(index, names.length, h), nx, ny: 0 }));
	const along = (names: readonly string[], y: number, ny: number) =>
		names.map((id, index) => ({ id, x: distributed(index, names.length, w), y, nx: 0, ny }));
	return [
		...across(left, -(w / 2 + 16_000), -1),
		...across(right, w / 2 + 16_000, 1),
		...along(bottom, h / 2 + 16_000, 1),
		...along(top, -(h / 2 + 16_000), -1)
	];
}

/** A terminal by name, `in`/`out` and `inN`/`outN` addressing the sides in order. */
function digitalResolve(component: DigitalComponent, name: string): LocalPort | undefined {
	const ports = digitalPorts(component);
	const exact = ports.find((entry) => entry.id === name);
	if (exact !== undefined) return exact;
	const { left, right } = digitalSides(component);
	/* `tap` on a splitter or joiner is the first output, as in 0.x. */
	if (component.kind === 'bus' && name === 'tap') return ports.find((entry) => entry.id === right[0]);
	const terminal = indexed(name, left.length, right.length);
	if (terminal === undefined) return undefined;
	const id = (terminal.output ? right : left)[terminal.index];
	return ports.find((entry) => entry.id === id);
}

const DIGITAL_LABELS: Readonly<Partial<Record<DigitalComponent['kind'], string>>> = {
	clock: 'CLK', encoder: 'ENC', decoder: 'DEC', register: 'REG', counter: 'CTR', comparator: 'CMP'
};

const digital: KindDef<DigitalComponent> = {
	parse(kind, common, options, line) {
		const typed = kind as DigitalComponent['kind'];
		only(options, ['type', 'inputs', 'outputs', 'width', 'orientation'], line);
		const [defaultInputs, defaultOutputs] = DIGITAL_DEFAULTS[typed];
		let inputs = count(options.get('inputs'), defaultInputs === 0 ? 1 : defaultInputs, 'inputs', line);
		let outputs = count(options.get('outputs'), defaultOutputs, 'outputs', line);
		if ((typed === 'logic' || typed === 'clock') && options.has('inputs')) throw new SchematicSyntaxError(`${typed} does not accept inputs.`, line);
		const bits = width(options.get('width'), typed === 'bus' || typed === 'register' ? 8 : 1, line);
		if (options.has('width') && typed !== 'bus' && typed !== 'register') throw new SchematicSyntaxError(`Option width is not supported for ${typed}.`, line);
		if (typed === 'bus' && bits < 2) throw new SchematicSyntaxError('Bus width must be at least 2.', line);
		const variants = DIGITAL_VARIANTS[typed];
		const variant = variants === undefined ? undefined : enumOption(options.get('type'), variants[0], variants[1], 'type', line);
		if (variant === undefined && options.has('type')) throw new SchematicSyntaxError(`Option type is not supported for ${typed}.`, line);
		if (typed === 'adder' && variant === 'full' && !options.has('inputs')) inputs = 3;
		if (typed === 'mux' && variant === 'demux') {
			if (!options.has('inputs')) inputs = 1;
			if (!options.has('outputs')) outputs = 2;
		}
		if (typed === 'bus' && variant === 'joiner' && !options.has('outputs')) outputs = 1;
		if ((typed === 'buffer' && (inputs !== 1 || outputs !== 1)) || ((typed === 'logic' || typed === 'clock') && outputs !== 1)) {
			throw new SchematicSyntaxError(`${typed} has fixed terminal counts.`, line);
		}
		const component: DigitalComponent = {
			kind: typed,
			...common,
			inputs: typed === 'logic' || typed === 'clock' ? 0 : inputs,
			outputs,
			width: bits,
			bodyWidth: typed === 'buffer' || typed === 'logic' || typed === 'clock' ? 56 : 84,
			bodyHeight: Math.max(52, Math.max(inputs, outputs) * 16 + 20),
			...orientation(options, line)
		};
		if (variant !== undefined) component.variant = variant as NonNullable<DigitalComponent['variant']>;
		return component;
	},
	extents: (component) => [component.bodyWidth * 500 + 16_000, component.bodyHeight * 500 + 16_000],
	ports: digitalPorts,
	resolve: digitalResolve,
	draw(component, paint) {
		if (component.kind === 'buffer') {
			const bubble = component.variant === 'tristate-inverter' || component.variant === 'schmitt-inverter';
			return `<path ${paint} d="M -44 0 H -28 M -28 -22 L 24 0 -28 22 Z M ${bubble ? 32 : 24} 0 H 44${component.variant?.startsWith('schmitt') === true ? ' M -17 -8 H -6 V 8 H 5' : ''}" />${bubble ? `<circle ${paint} cx="28" cy="0" r="4" />` : ''}${component.variant?.startsWith('tristate') === true ? `<path ${paint} d="M 0 42 V 12" />` : ''}`;
		}
		const w = component.bodyWidth * 1000;
		const h = component.bodyHeight * 1000;
		/* A lead from each terminal to the body edge, on every side. */
		let stubs = '';
		for (const port of digitalPorts(component)) {
			stubs += port.ny === 0
				? `<path ${paint} d="M ${n(port.x)} ${n(port.y)} H ${n(port.nx * (w / 2))}" />`
				: `<path ${paint} d="M ${n(port.x)} ${n(port.y)} V ${n(port.ny * (h / 2))}" />`;
		}
		return `<rect ${paint} x="${n(-w / 2)}" y="${n(-h / 2)}" width="${component.bodyWidth}" height="${component.bodyHeight}" rx="3" />${stubs}`;
	},
	inner(component) {
		const value =
			component.kind === 'buffer'
				? ''
				: component.kind === 'logic'
					? component.variant === 'high' ? '1' : component.variant === 'low' ? '0' : component.variant === 'high-z' ? 'Z' : 'X'
					: component.kind === 'mux'
						? component.variant === 'demux' ? 'DEMUX' : 'MUX'
						: component.kind === 'adder'
							? component.variant === 'full' ? 'FA' : 'HA'
							: component.kind === 'flipflop' || component.kind === 'bus'
								? String(component.variant).toUpperCase()
								: DIGITAL_LABELS[component.kind]!;
		return value === '' ? '' : `<text ${colorAttributes(component.color, 'schematic-gate-symbol')} stroke="none" x="0" y="4" text-anchor="middle" font-size="11">${value}</text>`;
	},
	symbol: (component) =>
		`digital-${component.kind}-${component.variant ?? ''}-${component.inputs}-${component.outputs}-${component.bodyWidth}-${component.bodyHeight}`
};

export const LOGIC_KINDS: Readonly<Record<string, KindDef<never>>> = {
	nand: gate, nor: gate, xor: gate, xnor: gate, and: gate, or: gate, not: gate,
	buffer: digital, logic: digital, clock: digital, flipflop: digital, mux: digital, encoder: digital,
	decoder: digital, register: digital, counter: digital, adder: digital, comparator: digital, bus: digital
} as unknown as Readonly<Record<string, KindDef<never>>>;
