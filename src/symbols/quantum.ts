/**
 * Quantum symbols: single-qubit operators, CNOT, multi-track gates, and
 * classical readout.
 *
 * @module
 */
import { mathLabelTextWidthAt, renderMathLabelTspans } from '../math-label.js';
import {
	NAMED_QUANTUM_GATE_KINDS,
	SchematicSyntaxError,
	type QuantumGateComponent,
	type QuantumSpecialComponent
} from '../types.js';
import { toMilli } from '../geom.js';
import {
	colorAttributes,
	count,
	enumOption,
	fit,
	fitText,
	includesValue,
	indexed,
	n,
	only,
	orientation,
	port,
	TEXT_PAINT,
	u,
	width,
	type KindDef,
	type LocalPort
} from './common.js';

/** Span of a glyph carrying `tracks` qubit lines, in milli-units. */
export function trackSpan(tracks: number): number {
	return Math.max(16_000, (tracks - 1) * 18_000);
}

/** Offset of track `index`, spread edge to edge so outer rails land at ±span/2. */
export function trackCoordinate(index: number, tracks: number): number {
	if (tracks <= 1) return 0;
	const span = trackSpan(tracks);
	return -span / 2 + (index * span) / (tracks - 1);
}

/**
 * Offset of rail `index` in milli-units: where a fitted gate's qubit wire
 * arrives, or spread edge to edge as {@link trackCoordinate} has it.
 */
function railAt(rails: readonly number[] | undefined, index: number, tracks: number): number {
	return rails === undefined ? trackCoordinate(index, tracks) : toMilli(rails[index]!);
}

/** Box and stub sizes of a single-qubit operator, in diagram units. */
export function gateDimensions(component: QuantumGateComponent): { bodyWidth: number; bodyHeight: number; stubExtent: number } {
	const details = [component.parameter, component.phase, component.matrix].filter((value): value is string => value !== undefined && value !== '');
	let widest = 16;
	if (details.length > 0 && component.kind === 'qgate') widest = mathLabelTextWidthAt(component.label, 14);
	for (const detail of details) widest = Math.max(widest, mathLabelTextWidthAt(detail, 10));
	const bodyWidth = Math.max(50, Math.min(104, widest + 20));
	return { bodyWidth, bodyHeight: 50 + details.length * 15, stubExtent: bodyWidth / 2 + 23 };
}

const GATE_SYMBOLS: Readonly<Record<QuantumGateComponent['kind'], string>> = {
	qgate: '', cnot: '⊕', hadamard: 'H', xgate: 'X', ygate: 'Y', zgate: 'Z', sgate: 'S', sdg: 'S†',
	tgate: 'T', tdg: 'T†', sx: '√X', phase: 'P', rx: 'Rx', ry: 'Ry', rz: 'Rz', ugate: 'U'
};

function gatePorts(component: QuantumGateComponent): LocalPort[] {
	const stub = Math.round(gateDimensions(component).stubExtent * 1000);
	return [{ id: 'in', x: -stub, y: 0, nx: -1, ny: 0 }, { id: 'out', x: stub, y: 0, nx: 1, ny: 0 }];
}

const operator: KindDef<QuantumGateComponent> = {
	parse(kind, common, options, line) {
		const detailed = kind === 'qgate' || includesValue(NAMED_QUANTUM_GATE_KINDS, kind);
		only(options, detailed ? ['parameter', 'matrix', 'phase', 'orientation'] : kind === 'cnot' ? ['orientation', 'fit'] : ['orientation'], line);
		const component: QuantumGateComponent = { kind: kind as QuantumGateComponent['kind'], ...common, ...orientation(options, line), ...fit(options, line) };
		if (detailed) {
			const parameter = options.get('parameter');
			const matrix = options.get('matrix');
			const phase = options.get('phase');
			if (parameter !== undefined) component.parameter = parameter;
			if (matrix !== undefined) component.matrix = matrix;
			if (phase !== undefined) component.phase = phase;
		}
		return component;
	},
	extents(component) {
		const { bodyHeight, stubExtent } = gateDimensions(component);
		return [Math.round(stubExtent * 1000), bodyHeight * 500];
	},
	ports: gatePorts,
	resolve: (component, name) => gatePorts(component).find((entry) => entry.id === name),
	draw(component, paint) {
		const { bodyWidth, bodyHeight, stubExtent } = gateDimensions(component);
		const half = bodyWidth / 2;
		return `<rect ${paint} x="${u(-half)}" y="${u(-bodyHeight / 2)}" width="${u(bodyWidth)}" height="${u(bodyHeight)}" rx="3" /><path ${paint} d="M ${u(-stubExtent)} 0 H ${u(-half)} M ${u(half)} 0 H ${u(stubExtent)}" />`;
	},
	inner(component) {
		const details = [component.parameter, component.phase, component.matrix].filter((value): value is string => value !== undefined && value !== '');
		const rows = [component.kind === 'qgate' ? component.label : GATE_SYMBOLS[component.kind], ...details];
		const { bodyWidth } = gateDimensions(component);
		const start = -((rows.length - 1) * 15) / 2 + 4;
		const text = rows
			.map(
				(value, index) =>
					`<text class="${index === 0 ? 'schematic-gate-symbol' : 'schematic-quantum-detail'}" ${TEXT_PAINT} x="0" y="${start + index * 15}" text-anchor="middle" font-size="${index === 0 ? 14 : 10}"${fitText(value, bodyWidth - 12, index === 0 ? 14 : 10)}>${renderMathLabelTspans(value)}</text>`
			)
			.join('');
		return `<g ${colorAttributes(component.color)}>${text}</g>`;
	},
	symbol(component) {
		const { bodyWidth, bodyHeight } = gateDimensions(component);
		return `quantum-shell-${bodyWidth}-${bodyHeight}`;
	}
};

/** A CNOT's control and target rails in milli-units, control first. */
function cnotRails(component: QuantumGateComponent): readonly [number, number] {
	return [railAt(component.rails, 0, 2), railAt(component.rails, 1, 2)];
}

function cnotPorts(component: QuantumGateComponent): LocalPort[] {
	const [control, target] = cnotRails(component);
	return [
		{ id: 'in1', x: -42_000, y: control, nx: -1, ny: 0 },
		{ id: 'in2', x: -42_000, y: target, nx: -1, ny: 0 },
		{ id: 'out1', x: 42_000, y: control, nx: 1, ny: 0 },
		{ id: 'out2', x: 42_000, y: target, nx: 1, ny: 0 },
		/* Each vertical terminal faces away from the other, whichever rail is on top. */
		{ id: 'control', x: 0, y: control, nx: 0, ny: control > target ? 1 : -1 },
		{ id: 'target', x: 0, y: target, nx: 0, ny: control > target ? -1 : 1 }
	];
}

const cnot: KindDef<QuantumGateComponent> = {
	parse: operator.parse,
	/* The target's circle reaches ten units past its rail; five more is clearance. */
	extents: (component) => [42_000, Math.max(...cnotRails(component).map(Math.abs)) + 15_000],
	ports: cnotPorts,
	resolve: (component, name) => cnotPorts(component).find((entry) => entry.id === (name === 'in' ? 'in1' : name === 'out' ? 'out1' : name)),
	draw(component, paint, nodePaint) {
		const [control, target] = cnotRails(component);
		const [c, t] = [n(control), n(target)];
		return `<path ${paint} d="M -42 ${c} H 42 M -42 ${t} H 42 M 0 ${c} V ${t} M -7 ${t} H 7 M 0 ${n(target - 7_000)} V ${n(target + 7_000)}" /><circle ${nodePaint} cx="0" cy="${c}" r="4" /><circle ${paint} cx="0" cy="${t}" r="10" />`;
	},
	symbol: (component) => (component.rails === undefined ? 'cnot' : `cnot-${component.rails.join('_')}`)
};

/* ---- multi-track and classical primitives ---- */

const CONTROLLED = new Set(['controlled', 'cz', 'cphase', 'toffoli']);
const COUNTED = new Set(['controlled', 'cz', 'cphase', 'toffoli', 'swap']);
const MULTI = new Set(['swap', 'cz', 'cphase', 'toffoli', 'controlled', 'barrier', 'delay']);

function tracksOf(component: QuantumSpecialComponent): number {
	return Math.max(component.wires, component.controls + component.targets);
}

function specialPorts(component: QuantumSpecialComponent): LocalPort[] {
	switch (component.kind) {
		case 'prepare':
			return [port('out', 40, 0, 1, 0)];
		case 'measure':
			return [port('in', -40, 0, -1, 0), port('out', 40, 0, 1, 0), port('classical', 0, 34, 0, 1)];
		case 'control':
			return [port('in', -42, 0, -1, 0), port('out', 42, 0, 1, 0), port('control', 0, 0, 0, -1)];
		case 'reset':
		case 'classical-bit':
		case 'classical-register':
			return [port('in', -40, 0, -1, 0), port('out', 40, 0, 1, 0)];
		default: {
			const tracks = tracksOf(component);
			const ports: LocalPort[] = [];
			for (let index = 0; index < tracks; index += 1) ports.push({ id: `in${index + 1}`, x: -42_000, y: railAt(component.rails, index, tracks), nx: -1, ny: 0 });
			for (let index = 0; index < tracks; index += 1) ports.push({ id: `out${index + 1}`, x: 42_000, y: railAt(component.rails, index, tracks), nx: 1, ny: 0 });
			/* A vertical terminal leaves upward, except on the lowest rail, where
			   upward would run its wire through every terminal above it. */
			let lowest = 0;
			for (let index = 1; index < tracks; index += 1) if (railAt(component.rails, index, tracks) > railAt(component.rails, lowest, tracks)) lowest = index;
			const vertical = (id: string, index: number): LocalPort => ({ id, x: 0, y: railAt(component.rails, index, tracks), nx: 0, ny: tracks > 1 && index === lowest ? 1 : -1 });
			for (let index = 0; index < component.controls; index += 1) ports.push(vertical(`control${index + 1}`, index));
			for (let index = 0; index < component.targets; index += 1) ports.push(vertical(`target${index + 1}`, component.controls + index));
			return ports;
		}
	}
}

const special: KindDef<QuantumSpecialComponent> = {
	parse(kind, common, options, line) {
		only(options, ['control', 'operator', 'controls', 'targets', 'wires', 'width', 'orientation', 'fit'], line);
		if (options.has('fit') && !MULTI.has(kind)) throw new SchematicSyntaxError(`Option fit is not supported for ${kind}; it lines up the rails of a gate that spans several qubits.`, line);
		if (options.has('control') && kind !== 'control' && kind !== 'controlled') throw new SchematicSyntaxError(`Option control is not supported for ${kind}.`, line);
		if (options.has('operator') && kind !== 'controlled') throw new SchematicSyntaxError(`Option operator is not supported for ${kind}.`, line);
		if ((options.has('controls') || options.has('targets')) && !COUNTED.has(kind)) throw new SchematicSyntaxError(`Control/target counts are not supported for ${kind}.`, line);
		if (options.has('wires') && kind !== 'barrier' && kind !== 'delay') throw new SchematicSyntaxError(`Option wires is not supported for ${kind}.`, line);
		if (options.has('width') && kind !== 'classical-register') throw new SchematicSyntaxError(`Option width is not supported for ${kind}.`, line);
		const controlType = enumOption(options.get('control'), 'positive', ['positive', 'negative', 'classical'] as const, 'control', line);
		const controlled = CONTROLLED.has(kind);
		const component: QuantumSpecialComponent = {
			kind: kind as QuantumSpecialComponent['kind'],
			...common,
			controls: count(options.get('controls'), kind === 'toffoli' ? 2 : controlled ? 1 : 0, 'controls', line),
			targets: count(options.get('targets'), kind === 'swap' ? 2 : controlled ? 1 : 0, 'targets', line),
			wires: count(options.get('wires'), kind === 'barrier' || kind === 'delay' ? 2 : 1, 'wires', line),
			width: width(options.get('width'), kind === 'classical-register' ? 8 : 1, line),
			...orientation(options, line),
			...fit(options, line)
		};
		if (kind === 'classical-register' && component.width < 2) throw new SchematicSyntaxError('Classical register width must be at least 2.', line);
		if (kind === 'control' || kind === 'controlled') component.controlType = controlType;
		const value = options.get('operator');
		if (value !== undefined) component.operator = value;
		return component;
	},
	extents(component) {
		if (component.kind === 'measure') return [42_000, 34_000];
		const tracks = tracksOf(component);
		let reach = 0;
		for (let index = 0; index < tracks; index += 1) reach = Math.max(reach, Math.abs(railAt(component.rails, index, tracks)));
		return [42_000, Math.max(24_000, reach + 14_000)];
	},
	ports: specialPorts,
	resolve(component, name) {
		const ports = specialPorts(component);
		if (!MULTI.has(component.kind)) {
			if (component.kind === 'reset' && /^(in|out)1$/.test(name)) name = name.slice(0, -1);
			return ports.find((entry) => entry.id === name);
		}
		const tracks = tracksOf(component);
		const terminal = indexed(name, tracks, tracks);
		if (terminal !== undefined) return ports[(terminal.output ? tracks : 0) + terminal.index];
		return ports.find((entry) => entry.id === name);
	},
	draw(component, paint, nodePaint) {
		switch (component.kind) {
			case 'measure':
				return `<path ${paint} d="M -40 0 H -22 M 22 0 H 40 M 0 22 V 34" /><rect ${paint} x="-22" y="-22" width="44" height="44" rx="3" /><path ${paint} d="M -12 8 A 15 15 0 0 1 12 8 M 0 8 L 11 -9" />`;
			case 'prepare':
				return `<path ${paint} d="M 0 0 H 40 M -10 -10 L 10 0 -10 10 Z" />`;
			case 'reset':
				return `<path ${paint} d="M -40 0 H -18 M 18 0 H 40" /><rect ${paint} x="-18" y="-18" width="36" height="36" rx="3" /><path ${paint} d="M 9 -8 A 12 12 0 1 0 10 7 M 9 -8 H 1 M 9 -8 V 0" />`;
			case 'control':
				return `<path ${paint} d="M -42 0 H 42" />${component.controlType === 'negative' ? `<circle ${paint} cx="0" cy="0" r="5" />` : `<circle ${nodePaint} cx="0" cy="0" r="5" />`}`;
			case 'classical-bit':
			case 'classical-register':
				return `<path ${paint} d="M -40 -2 H 40 M -40 2 H 40" />`;
		}
		const tracks = tracksOf(component);
		const rails = Array.from({ length: tracks }, (_, index) => railAt(component.rails, index, tracks));
		/* Unfitted, the glyph spans the track span even for a single track. */
		const top = component.rails === undefined ? -trackSpan(tracks) / 2 : Math.min(...rails);
		const bottom = component.rails === undefined ? trackSpan(tracks) / 2 : Math.max(...rails);
		let lines = '';
		for (const rail of rails) lines += `<path ${paint} d="M -42 ${n(rail)} H 42" />`;
		if (component.kind === 'barrier') return `${lines}<path ${paint} stroke-dasharray="4 3" d="M 0 ${n(top - 8_000)} V ${n(bottom + 8_000)}" />`;
		if (component.kind === 'delay') return `${lines}<rect ${paint} x="-12" y="${n(top - 7_000)}" width="24" height="${n(bottom - top + 14_000)}" rx="2" />`;
		let marks = '';
		for (let index = 0; index < tracks; index += 1) {
			const y = rails[index]!;
			if (component.kind === 'swap') marks += `<path ${paint} d="M -6 ${n(y - 6_000)} L 6 ${n(y + 6_000)} M 6 ${n(y - 6_000)} L -6 ${n(y + 6_000)}" />`;
			else if (component.kind === 'cz') marks += `<circle ${nodePaint} cx="0" cy="${n(y)}" r="4" />`;
			else if (index < component.controls) {
				if (component.controlType === 'negative') marks += `<circle ${paint} cx="0" cy="${n(y)}" r="5" />`;
				else if (component.controlType === 'classical') marks += `<rect ${nodePaint} x="-5" y="${n(y - 5_000)}" width="10" height="10" />`;
				else marks += `<circle ${nodePaint} cx="0" cy="${n(y)}" r="4" />`;
			} else if (component.kind === 'controlled' || component.kind === 'cphase') marks += `<rect ${paint} x="-10" y="${n(y - 10_000)}" width="20" height="20" rx="2" />`;
			else marks += `<circle ${paint} cx="0" cy="${n(y)}" r="10" /><path ${paint} d="M -7 ${n(y)} H 7 M 0 ${n(y - 7_000)} V ${n(y + 7_000)}" />`;
		}
		return `${lines}<path ${paint} d="M 0 ${n(top)} V ${n(bottom)}" />${marks}`;
	},
	inner: (component) =>
		component.kind === 'controlled' && component.operator !== undefined
			? `<text ${colorAttributes(component.color, 'schematic-gate-symbol')} stroke="none" x="0" y="4" text-anchor="middle" font-size="11">${renderMathLabelTspans(component.operator)}</text>`
			: '',
	symbol: (component) =>
		`quantum-${component.kind}-${component.controlType ?? ''}-${component.controls}-${component.targets}-${component.wires}${component.rails === undefined ? '' : `-${component.rails.join('_')}`}`
};

export const QUANTUM_KINDS: Readonly<Record<string, KindDef<never>>> = {
	hadamard: operator, qgate: operator, xgate: operator, ygate: operator, zgate: operator, sgate: operator,
	sdg: operator, tgate: operator, tdg: operator, sx: operator, phase: operator, rx: operator, ry: operator,
	rz: operator, ugate: operator, cnot,
	measure: special, reset: special, prepare: special, swap: special, control: special, cz: special,
	cphase: special, toffoli: special, controlled: special, barrier: special, delay: special,
	'classical-bit': special, 'classical-register': special
} as unknown as Readonly<Record<string, KindDef<never>>>;
