/**
 * Electrical symbols: passives, semiconductors, boundaries, sources, switching,
 * instruments, loads, and integrated circuits.
 *
 * @module
 */
import { toMilli } from '../geom.js';
import { escapeXml } from '../xml.js';
import { renderMathLabelTspans } from '../math-label.js';
import {
	AMPLIFIER_TYPES,
	DIODE_TYPES,
	GROUND_STYLES,
	LOAD_TYPES,
	METER_TYPES,
	POWER_TYPES,
	PROTECTION_TYPES,
	RESONATOR_TYPES,
	SOURCE_TYPES,
	SWITCH_TYPES,
	SchematicSyntaxError,
	TRANSISTOR_TYPES,
	type DiodeComponent,
	type ElectricalComponent,
	type GroundComponent,
	type IcComponent,
	type IntegratedCircuitPins,
	type PassiveComponent,
	type PortComponent,
	type TransistorComponent
} from '../types.js';
import {
	byName,
	colorAttributes,
	distributed,
	enumOption,
	fit,
	fitText,
	n,
	named,
	only,
	orientation,
	port,
	TEXT_PAINT,
	width,
	type KindDef,
	type LocalPort
} from './common.js';

const IN = port('in', -42, 0, -1, 0);
const OUT = port('out', 42, 0, 1, 0);

/** Two terminals at ±42 with the conventional left/right aliases. */
function twoTerminal(ports: readonly [LocalPort, LocalPort], aliases: Readonly<Record<string, 0 | 1>>) {
	return {
		ports: () => ports,
		resolve: (_: unknown, name: string) => {
			const index = aliases[name];
			return index === undefined ? undefined : ports[index];
		}
	};
}

const PASSIVE_ALIASES = { in: 0, left: 0, l: 0, out: 1, right: 1, r: 1 } as const;

const passive: KindDef<PassiveComponent> = {
	parse(kind, common, options, line) {
		only(options, ['type', 'orientation'], line);
		const allowed =
			kind === 'resistor'
				? (['fixed', 'variable', 'rheostat', 'potentiometer', 'thermistor', 'ldr'] as const)
				: kind === 'capacitor'
					? (['fixed', 'variable', 'polarized'] as const)
					: (['fixed', 'coupled', 'transformer'] as const);
		const passiveType = enumOption(options.get('type'), 'fixed', allowed, 'type', line);
		const base = { kind: kind as PassiveComponent['kind'], ...common, ...orientation(options, line) };
		return passiveType === 'fixed' ? base : { kind: base.kind, ...common, passiveType, ...orientation(options, line) };
	},
	extents: () => [42_000, 18_000],
	...twoTerminal([IN, OUT], PASSIVE_ALIASES),
	draw(component, paint) {
		const variant = component.passiveType ?? 'fixed';
		if (component.kind === 'resistor') {
			const base = `<path ${paint} d="M -42 0 H -26 L -20 -12 L -10 12 L 0 -12 L 10 12 L 20 -12 L 26 0 H 42" />`;
			if (variant === 'variable' || variant === 'rheostat' || variant === 'potentiometer') {
				return `${base}<path ${paint} d="M -18 20 L 18 -20 M 11 -20 H 18 V -13${variant === 'potentiometer' ? ' M 0 28 V 12' : ''}" />`;
			}
			if (variant === 'thermistor') return `${base}<path ${paint} d="M -18 19 L 18 -19 M 10 -19 H 18 V -11" />`;
			if (variant === 'ldr') return `${base}<path ${paint} d="M 15 -27 L 4 -16 M 4 -16 H 9 V -21 M 27 -20 L 16 -9 M 16 -9 H 21 V -14" />`;
			return base;
		}
		if (component.kind === 'capacitor') {
			const plate = variant === 'polarized' ? 'M 7 -18 Q 13 0 7 18' : 'M 7 -18 V 18';
			const variable = variant === 'variable' ? `<path ${paint} d="M -18 20 L 18 -20 M 11 -20 H 18 V -13" />` : '';
			const positive = variant === 'polarized' ? `<path ${paint} d="M -17 -12 H -9 M -13 -16 V -8" />` : '';
			return `<path ${paint} d="M -42 0 H -7 M -7 -18 V 18 ${plate} M 7 0 H 42" />${variable}${positive}`;
		}
		const base = `<path ${paint} d="M -42 0 H -28 C -28 -16 -14 -16 -14 0 C -14 -16 0 -16 0 0 C 0 -16 14 -16 14 0 C 14 -16 28 -16 28 0 H 42" />`;
		return variant === 'fixed'
			? base
			: `${base}<path ${paint} d="M -28 12 C -28 28 -14 28 -14 12 C -14 28 0 28 0 12 C 0 28 14 28 14 12 C 14 28 28 28 28 12${variant === 'transformer' ? ' M -33 5 H 33 M -33 8 H 33' : ''}" />`;
	},
	symbol: (component) => (component.passiveType === undefined ? component.kind : `${component.kind}-${component.passiveType}`)
};

const ANODE = port('anode', -42, 0, -1, 0);
const CATHODE = port('cathode', 42, 0, 1, 0);

const diode: KindDef<DiodeComponent> = {
	parse(_, common, options, line) {
		only(options, ['type', 'orientation'], line);
		return { kind: 'diode', ...common, diodeType: enumOption(options.get('type'), 'standard', DIODE_TYPES, 'type', line), ...orientation(options, line) };
	},
	extents: (component) => [42_000, component.diodeType === 'led' || component.diodeType === 'photodiode' ? 30_000 : 20_000],
	...twoTerminal([ANODE, CATHODE], { anode: 0, a: 0, cathode: 1, k: 1, c: 1 }),
	draw(component, paint) {
		const junction = `<path ${paint} d="M -42 0 H -14 M -14 -16 L 10 0 L -14 16 Z M 10 -16 V 16 M 10 0 H 42" />`;
		switch (component.diodeType) {
			case 'standard':
				return junction;
			case 'schottky':
				return `${junction}<path ${paint} d="M 10 -16 H 16 V -10 M 10 16 H 4 V 10" />`;
			case 'zener':
				return `${junction}<path ${paint} d="M 4 -20 L 10 -16 M 10 16 L 16 20" />`;
			case 'led':
				return `${junction}<path ${paint} d="M -1 -18 L 11 -30 M 6 -30 H 11 V -25 M 8 -14 L 20 -26 M 15 -26 H 20 V -21" />`;
			case 'photodiode':
				return `${junction}<path ${paint} d="M 18 -30 L 6 -18 M 6 -18 H 11 V -23 M 27 -22 L 15 -10 M 15 -10 H 20 V -15" />`;
			case 'varactor':
				return `${junction}<path ${paint} d="M 16 -16 V 16" />`;
			case 'scr':
				return `${junction}<path ${paint} d="M 10 10 L 24 22 H 34" />`;
			case 'triac':
				return `<path ${paint} d="M -42 0 H -15 L 9 -15 V 15 L -15 0 M 42 0 H 15 L -9 15 V -15 L 15 0 M 5 12 L 23 25 H 34" />`;
		}
	},
	symbol: (component) => `diode-${component.diodeType}`
};

const CONTROL = port('base', -42, 0, -1, 0);
const UPPER = port('collector', 42, -22, 1, 0);
const LOWER = port('emitter', 42, 22, 1, 0);
const TRANSISTOR_NAMES: Readonly<Record<string, 0 | 1 | 2>> = {
	base: 0, gate: 0, b: 0, g: 0, collector: 1, drain: 1, c: 1, d: 1, emitter: 2, source: 2, e: 2, s: 2
};

const transistor: KindDef<TransistorComponent> = {
	parse(_, common, options, line) {
		only(options, ['type', 'orientation'], line);
		return { kind: 'transistor', ...common, transistorType: enumOption(options.get('type'), 'npn', TRANSISTOR_TYPES, 'type', line), ...orientation(options, line) };
	},
	extents: () => [42_000, 38_000],
	ports(component) {
		return component.transistorType === 'npn' || component.transistorType === 'pnp'
			? [CONTROL, UPPER, LOWER]
			: [named(CONTROL, 'gate'), named(UPPER, 'drain'), named(LOWER, 'source')];
	},
	resolve(component, name) {
		const index = TRANSISTOR_NAMES[name];
		return index === undefined ? undefined : transistor.ports(component)[index];
	},
	draw(component, paint) {
		const type = component.transistorType;
		if (type === 'npn' || type === 'pnp') {
			const arrow = type === 'npn' ? 'M 12 17 L 24 25 L 20 12' : 'M 0 7 L 12 17 L 0 20';
			return `<circle ${paint} cx="0" cy="0" r="30" /><path ${paint} d="M -42 0 H -9 M -9 -18 V 18 M -9 -10 L 20 -22 H 42 M -9 10 L 20 22 H 42 ${arrow}" />`;
		}
		const pChannel = type.startsWith('p');
		if (type.endsWith('jfet')) {
			const arrow = pChannel ? 'M -5 -5 L 5 0 L -5 5' : 'M 5 -5 L -5 0 L 5 5';
			return `<circle ${paint} cx="0" cy="0" r="30" /><path ${paint} d="M -42 0 H 4 M 4 -18 V 18 M 4 -12 L 20 -22 H 42 M 4 12 L 20 22 H 42 ${arrow}" />`;
		}
		const control = pChannel ? `<path ${paint} d="M -42 0 H -16" /><circle ${paint} cx="-11" cy="0" r="5" />` : `<path ${paint} d="M -42 0 H -10" />`;
		const arrow = pChannel ? 'M 16 -3 L 5 3 L 16 9' : 'M 5 -3 L 16 3 L 5 9';
		return `<circle ${paint} cx="0" cy="0" r="30" />${control}<path ${paint} d="M -10 -19 V 19 M 4 -17 V 17 M 4 -11 L 20 -22 H 42 M 4 11 L 20 22 H 42 ${arrow}${type.endsWith('igbt') ? ' M 9 -11 V 11' : ''}" />`;
	},
	symbol: (component) => `transistor-${component.transistorType}`
};

const boundary: KindDef<PortComponent> = {
	parse(_, common, options, line) {
		only(options, ['width', 'orientation'], line);
		const bits = width(options.get('width'), 1, line);
		return bits === 1 ? { kind: 'port', ...common, ...orientation(options, line) } : { kind: 'port', ...common, width: bits, ...orientation(options, line) };
	},
	extents: () => [42_000, 18_000],
	...twoTerminal([IN, OUT], { in: 0, out: 1 }),
	draw: (_, paint) => `<path ${paint} d="M -42 0 H -24 M 24 0 H 42 M -24 -16 H 14 L 24 0 L 14 16 H -24 Z" />`
};

const GROUND_IN = port('in', 0, -42, 0, -1);

const ground: KindDef<GroundComponent> = {
	parse(_, common, options, line) {
		only(options, ['style', 'orientation'], line);
		return { kind: 'ground', ...common, groundStyle: enumOption(options.get('style'), 'signal', GROUND_STYLES, 'style', line), ...orientation(options, line) };
	},
	extents: () => [22_000, 42_000],
	ports: () => [GROUND_IN],
	resolve: (_, name) => (name === 'in' ? GROUND_IN : undefined),
	draw(component, paint) {
		const stem = `<path ${paint} d="M 0 -42 V -10" />`;
		switch (component.groundStyle) {
			case 'signal':
				return `${stem}<path ${paint} d="M -15 -10 H 15 L 0 15 Z" />`;
			case 'earth':
				return `${stem}<path ${paint} d="M -20 -10 H 20 M -13 -3 H 13 M -6 4 H 6" />`;
			case 'chassis':
				return `${stem}<path ${paint} d="M -20 -10 H 20 M -14 -10 L -20 2 M 0 -10 L -6 2 M 14 -10 L 8 2" />`;
		}
	},
	symbol: (component) => `ground-${component.groundStyle}`
};

/* ---- the compact electrical library ---- */

const NODE = port('node', 0, 0, -1, 0);
const DEPENDENT = new Set(['vcvs', 'vccs', 'ccvs', 'cccs']);

const electricalDefaults: Readonly<Record<string, readonly [string, readonly string[]]>> = {
	source: ['voltage-dc', SOURCE_TYPES],
	power: ['vcc', POWER_TYPES],
	switch: ['spst', SWITCH_TYPES],
	protection: ['fuse', PROTECTION_TYPES],
	amplifier: ['opamp', AMPLIFIER_TYPES],
	resonator: ['crystal', RESONATOR_TYPES],
	meter: ['voltmeter', METER_TYPES],
	load: ['lamp', LOAD_TYPES]
};

function electricalPorts(component: ElectricalComponent): LocalPort[] {
	const variant = component.variant ?? '';
	switch (component.kind) {
		case 'junction':
		case 'testpoint':
			return [NODE];
		case 'connector':
			return [port('in', -32, 0, -1, 0), port('out', 32, 0, 1, 0)];
		case 'source': {
			const ports = [named(IN, 'negative'), named(OUT, 'positive')];
			if (DEPENDENT.has(variant)) ports.push(port('control-positive', 0, -34, 0, -1), port('control-negative', 0, 34, 0, 1));
			return ports;
		}
		case 'power':
			return [port('in', -32, 0, -1, 0)];
		case 'switch':
			if (variant === 'spdt') return [named(IN, 'common'), port('normally-open', 42, -12, 1, 0), port('normally-closed', 42, 12, 1, 0)];
			if (variant === 'relay') return [IN, OUT, port('coil1', -12, 34, 0, 1), port('coil2', 12, 34, 0, 1)];
			return [IN, OUT];
		case 'amplifier':
			return [port('positive', -48, -13, -1, 0), port('negative', -48, 13, -1, 0), port('out', 48, 0, 1, 0), port('v+', 0, -36, 0, -1), port('v-', 0, 36, 0, 1)];
		default:
			return [IN, OUT];
	}
}

const electrical: KindDef<ElectricalComponent> = {
	parse(kind, common, options, line) {
		const typed = kind as ElectricalComponent['kind'];
		if (typed === 'junction' || typed === 'testpoint') {
			only(options, [], line);
			return { kind: typed, ...common } as ElectricalComponent;
		}
		if (typed === 'connector') {
			only(options, ['orientation'], line);
			return { kind: typed, ...common, ...orientation(options, line) } as ElectricalComponent;
		}
		only(options, ['type', 'orientation'], line);
		const [fallback, values] = electricalDefaults[typed]!;
		const variant = enumOption(options.get('type'), fallback, values, 'type', line) as ElectricalComponent['variant'];
		return { kind: typed, ...common, variant: variant!, ...orientation(options, line) } as ElectricalComponent;
	},
	extents(component) {
		switch (component.kind) {
			case 'junction':
				return [5_000, 5_000];
			case 'testpoint':
				return [12_000, 12_000];
			case 'connector':
			case 'power':
				return [32_000, 18_000];
			case 'source':
				return [42_000, 34_000];
			case 'switch':
				return [42_000, component.variant === 'relay' ? 34_000 : 20_000];
			case 'amplifier':
				return [48_000, 36_000];
			default:
				return [42_000, 24_000];
		}
	},
	ports: electricalPorts,
	resolve(component, name) {
		const ports = electricalPorts(component);
		const exact = byName(ports, name);
		if (exact !== undefined) return exact;
		switch (component.kind) {
			case 'junction':
			case 'testpoint':
				return name === 'in' ? NODE : name === 'out' ? { ...NODE, nx: 1 } : undefined;
			case 'source':
				return name === 'in' ? ports[0] : name === 'out' ? ports[1] : undefined;
			case 'switch':
				if (component.variant === 'spdt') return name === 'in' ? ports[0] : name === 'out' ? OUT : undefined;
				return undefined;
			case 'amplifier':
				return name === 'in' ? ports[0] : undefined;
			default:
				return undefined;
		}
	},
	draw(component, paint, nodePaint) {
		const variant = component.variant ?? '';
		switch (component.kind) {
			case 'junction':
				return `<circle ${nodePaint} cx="0" cy="0" r="4" />`;
			case 'testpoint':
				return `<circle ${paint} cx="0" cy="0" r="9" /><circle ${nodePaint} cx="0" cy="0" r="2" />`;
			case 'connector':
				return `<path ${paint} d="M -32 0 H -9 M 9 0 H 32" /><circle ${paint} cx="0" cy="0" r="9" />`;
			case 'source': {
				if (variant === 'battery') return `<path ${paint} d="M -42 0 H -8 M -8 -10 V 10 M 8 -16 V 16 M 8 0 H 42" />`;
				const dependent = DEPENDENT.has(variant);
				const body = dependent ? `<path ${paint} d="M -24 0 L 0 -24 24 0 0 24 Z" />` : `<circle ${paint} cx="0" cy="0" r="24" />`;
				const controls = dependent ? `<path ${paint} d="M 0 -34 V -24 M 0 24 V 34" />` : '';
				const current = variant.startsWith('current') || variant.endsWith('cs');
				const glyph = variant.endsWith('ac')
					? `<path ${paint} d="M -13 0 C -8 -12 -4 -12 0 0 C 4 12 8 12 13 0" />`
					: variant === 'voltage-pulse'
						? `<path ${paint} d="M -14 8 H -7 V -8 H 7 V 8 H 14" />`
						: current
							? `<path ${paint} d="M 0 12 V -12 M -6 -5 L 0 -12 6 -5" />`
							: `<path ${paint} d="M -7 -8 H 7 M 0 -15 V -1 M -7 9 H 7" />`;
				return `<path ${paint} d="M -42 0 H -24 M 24 0 H 42" />${body}${controls}${glyph}`;
			}
			case 'power':
				return `<path ${paint} d="M -32 0 H 0 M 0 -13 V 13 M 0 -13 L 15 0 0 13" />`;
			case 'switch': {
				const relay = variant === 'relay' ? `<path ${paint} d="M -12 34 C -12 18 12 18 12 34 M 0 19 V 8" />` : '';
				const throw2 = variant === 'spdt' ? `<path ${paint} d="M 26 12 H 42" />` : '';
				return `<path ${paint} d="M -42 0 H -24 M -24 0 L 22 -12 M 26 -12 H 42" />${throw2}${relay}`;
			}
			case 'protection':
				return variant === 'breaker'
					? `<path ${paint} d="M -42 0 H -18 M -18 0 L 18 -12 M 18 0 H 42" />`
					: `<path ${paint} d="M -42 0 H -24 M 24 0 H 42" /><rect ${paint} x="-24" y="-9" width="48" height="18" rx="4" />`;
			case 'amplifier':
				return `<path ${paint} d="M -48 -13 H -30 M -48 13 H -30 M -30 -30 L 30 0 -30 30 Z M 30 0 H 48 M 0 -36 V -15 M 0 15 V 36 M -25 -17 H -17 M -21 -21 V -13 M -25 13 H -17" />`;
			case 'resonator':
				return `<path ${paint} d="M -42 0 H -12 M -12 -18 V 18 M 12 -18 V 18 M 12 0 H 42" /><rect ${paint} x="-7" y="-14" width="14" height="28" />`;
			default:
				return `<path ${paint} d="M -42 0 H -24 M 24 0 H 42" /><circle ${paint} cx="0" cy="0" r="24" />${
					variant === 'lamp'
						? `<path ${paint} d="M -15 -15 L 15 15 M 15 -15 L -15 15" />`
						: variant === 'speaker'
							? `<path ${paint} d="M -12 -9 H -3 L 8 -19 V 19 L -3 9 H -12 Z M 13 -10 Q 22 0 13 10" />`
							: variant === 'buzzer'
								? `<path ${paint} d="M -12 -9 H -3 L 8 -18 V 18 L -3 9 H -12 Z M 13 -8 L 20 -14 M 15 0 H 24 M 13 8 L 20 14" />`
								: ''
				}`;
		}
	},
	inner(component) {
		if ((component.kind !== 'meter' && component.kind !== 'load') || component.variant === 'lamp' || component.variant === 'speaker' || component.variant === 'buzzer') return '';
		return `<text ${colorAttributes(component.color, 'schematic-gate-symbol')} stroke="none" x="0" y="5" text-anchor="middle" font-size="14">${component.variant === 'voltmeter' ? 'V' : component.variant === 'ammeter' ? 'A' : 'M'}</text>`;
	},
	symbol: (component) => `${component.kind}-${component.variant ?? ''}`
};

/* ---- integrated circuits ---- */

const MAX_IC_PINS_PER_SIDE = 64;
const RESERVED = new Set(['in', 'out']);
const SIDES = ['left', 'right', 'top', 'bottom'] as const;
type Side = (typeof SIDES)[number];
const NORMALS: Readonly<Record<Side, readonly [number, number]>> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** Where pin `index` of `side` sits, in milli-units. */
export function icPin(component: IcComponent, side: Side, index: number): LocalPort {
	const pins = component.pins[side];
	const w = component.bodyWidth * 1000;
	const h = component.bodyHeight * 1000;
	const [nx, ny] = NORMALS[side];
	const fitted = side === 'left' || side === 'right' ? component.rows?.[side][index] : undefined;
	return side === 'left' || side === 'right'
		? { id: pins[index]!, x: nx * (w / 2 + 16_000), y: fitted === undefined ? distributed(index, pins.length, h) : toMilli(fitted), nx, ny }
		: { id: pins[index]!, x: distributed(index, pins.length, w), y: ny * (h / 2 + 16_000), nx, ny };
}

function icPorts(component: IcComponent): LocalPort[] {
	return SIDES.flatMap((side) => component.pins[side].map((_, index) => icPin(component, side, index)));
}

const ic: KindDef<IcComponent> = {
	parse(_, common, options, line) {
		only(options, ['left', 'right', 'top', 'bottom', 'orientation', 'fit'], line);
		const registered = new Set<string>();
		const side = (name: Side): readonly string[] => {
			const source = options.get(name);
			if (source === undefined || source.trim() === '') return [];
			const pins = source.split(',').map((pin) => pin.trim());
			if (pins.length > MAX_IC_PINS_PER_SIDE) throw new SchematicSyntaxError(`${name} supports at most ${MAX_IC_PINS_PER_SIDE} IC pins.`, line);
			for (const pin of pins) {
				if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(pin)) throw new SchematicSyntaxError(`Invalid IC pin name ${pin || '(empty)'}.`, line);
				if (RESERVED.has(pin)) throw new SchematicSyntaxError(`IC pin ${pin} collides with the reserved ${pin} alias. Use ${pin}1 or another pin name.`, line);
				if (registered.has(pin)) throw new SchematicSyntaxError(`Duplicate IC pin ${pin}.`, line);
				registered.add(pin);
			}
			return pins;
		};
		const pins: IntegratedCircuitPins = { left: side('left'), right: side('right'), top: side('top'), bottom: side('bottom') };
		if (registered.size === 0) throw new SchematicSyntaxError('An IC must declare at least one pin.', line);
		return {
			kind: 'ic',
			...common,
			pins,
			bodyWidth: Math.max(88, Math.max(pins.top.length, pins.bottom.length) * 22 + 24),
			bodyHeight: Math.max(64, Math.max(pins.left.length, pins.right.length) * 18 + 24),
			...orientation(options, line),
			...fit(options, line)
		};
	},
	extents: (component) => [component.bodyWidth * 500 + 16_000, component.bodyHeight * 500 + 16_000],
	ports: icPorts,
	resolve(component, name) {
		const ports = icPorts(component);
		if (name === 'in' || name === 'out') {
			const canonical = byName(ports, `${name}1`);
			if (canonical !== undefined) return named(canonical, name);
			for (const side of name === 'in' ? (['left', 'top'] as const) : (['right', 'bottom'] as const)) {
				if (component.pins[side].length > 0) return named(icPin(component, side, 0), name);
			}
			return undefined;
		}
		return byName(ports, name);
	},
	draw(component, paint) {
		const w = component.bodyWidth * 1000;
		const h = component.bodyHeight * 1000;
		let pins = '';
		for (const side of SIDES) {
			const list = component.pins[side];
			const sign = side === 'left' || side === 'top' ? -1 : 1;
			if (side === 'left' || side === 'right') {
				const stub = n(sign * (w / 2 + 16_000));
				const body = n((sign * w) / 2);
				const [head, tail] = side === 'left' ? [stub, body] : [body, stub];
				const labelX = n(sign * (w / 2 - 5_000));
				const fitted = Math.max(8, component.bodyWidth / 2 - 10);
				list.forEach((pin, index) => {
					const { y } = icPin(component, side, index);
					pins += `<path ${paint} d="M ${head} ${n(y)} H ${tail}" /><text class="schematic-pin-label" ${TEXT_PAINT} x="${labelX}" y="${n(y + 3_000)}" text-anchor="${side === 'left' ? 'start' : 'end'}" font-size="10"${fitText(pin, fitted, 10)}>${escapeXml(pin)}</text>`;
				});
			} else {
				const stub = n(sign * (h / 2 + 16_000));
				const body = n((sign * h) / 2);
				const [head, tail] = side === 'top' ? [stub, body] : [body, stub];
				const labelY = n(sign * (h / 2 - 5_000));
				const fitted = Math.max(8, component.bodyHeight / 2 - 10);
				list.forEach((pin, index) => {
					const x = n(distributed(index, list.length, w));
					pins += `<path ${paint} d="M ${x} ${head} V ${tail}" /><text class="schematic-pin-label" ${TEXT_PAINT} x="${x}" y="${labelY}" text-anchor="start" font-size="10"${fitText(pin, fitted, 10)} transform="rotate(${side === 'top' ? 90 : -90} ${x} ${labelY})">${escapeXml(pin)}</text>`;
				});
			}
		}
		return `<rect ${paint} x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx="3" />${pins}`;
	},
	inner: (component) =>
		`<text class="schematic-gate-symbol" ${TEXT_PAINT} x="0" y="4" text-anchor="middle" font-size="12"${fitText(component.label, component.bodyWidth - 12, 12)}>${renderMathLabelTspans(component.label)}</text>`
};

export const ELECTRICAL_KINDS: Readonly<Record<string, KindDef<never>>> = {
	resistor: passive,
	capacitor: passive,
	inductor: passive,
	diode,
	transistor,
	port: boundary,
	ground,
	source: electrical,
	junction: electrical,
	testpoint: electrical,
	connector: electrical,
	power: electrical,
	switch: electrical,
	protection: electrical,
	amplifier: electrical,
	resonator: electrical,
	meter: electrical,
	load: electrical,
	ic
} as unknown as Readonly<Record<string, KindDef<never>>>;
