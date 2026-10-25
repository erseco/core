/**
 * What every component kind accepts, as data.
 *
 * The parser checks options in code, kind by kind, which is the right place for
 * the checks and the wrong place for a reader. An editor that wants to list a
 * kind's options, their types, their ranges and their defaults would otherwise
 * have to copy them by hand and drift. This module states them once, and
 * `tests/schema.test.ts` proves the statement against the parser: every declared
 * value is accepted, every value just outside a declared range is rejected,
 * every option a kind does not declare is rejected, and every declared default
 * draws the same figure as leaving the option out.
 *
 * It is a separate entry, `@schemd/core/schema`, so a host that only compiles
 * never ships it.
 *
 * @module
 */
import { KINDS } from './symbols/index.js';
import {
	ADDER_TYPES,
	AMPLIFIER_TYPES,
	BUFFER_TYPES,
	BUS_TYPES,
	CLASSICAL_GATE_KINDS,
	COMPONENT_KINDS,
	DIODE_TYPES,
	FLIPFLOP_TYPES,
	GROUND_STYLES,
	LOAD_TYPES,
	LOGIC_STATES,
	METER_TYPES,
	MUX_TYPES,
	NAMED_QUANTUM_GATE_KINDS,
	POWER_TYPES,
	PROTECTION_TYPES,
	RESONATOR_TYPES,
	SCHEMATIC_ORIENTATIONS,
	SOURCE_TYPES,
	SWITCH_TYPES,
	SchematicSyntaxError,
	TRANSISTOR_TYPES,
	type ComponentKind
} from './types.js';

/** One of a fixed set of words. */
export interface SchematicEnumOption {
	readonly name: string;
	readonly type: 'enum';
	readonly values: readonly string[];
	/** The value used when the option is left out, if there is one. */
	readonly default?: string;
}

/** A whole number, or for `number` a decimal, within a closed range. */
export interface SchematicNumberOption {
	readonly name: string;
	readonly type: 'integer' | 'number';
	readonly min: number;
	readonly max: number;
	/** The value used when the option is left out, if it does not depend on anything else. */
	readonly default?: number;
	/** Defaults that depend on the kind's `type`, keyed by that type. */
	readonly defaultsByType?: Readonly<Record<string, number>>;
}

/** Free text, such as a gate's operator or a UML stereotype. */
export interface SchematicTextOption {
	readonly name: string;
	readonly type: 'text';
	readonly minLength: number;
	readonly maxLength?: number;
}

/** A comma-separated list of pin names, each one a port of the part. */
export interface SchematicPinsOption {
	readonly name: string;
	readonly type: 'pins';
	readonly maxItems: number;
	/** The pattern each pin name must match. */
	readonly pattern: string;
	/** Names a pin may not take, because they are already terminal aliases. */
	readonly reserved: readonly string[];
}

/** A semicolon-separated list of text rows, such as a class's attributes. */
export interface SchematicRowsOption {
	readonly name: string;
	readonly type: 'rows';
	readonly maxItems: number;
	readonly maxLength: number;
}

/** One option a kind accepts. */
export type SchematicOptionSchema =
	| SchematicEnumOption
	| SchematicNumberOption
	| SchematicTextOption
	| SchematicPinsOption
	| SchematicRowsOption;

/** The domain a kind belongs to. */
export type SchematicComponentFamily = 'electrical' | 'digital' | 'quantum' | 'uml';

/** Everything a declaration of one kind may say after its colour. */
export interface SchematicComponentSchema {
	readonly kind: ComponentKind;
	readonly family: SchematicComponentFamily;
	/** Every option the kind accepts, in a stable order. */
	readonly options: readonly SchematicOptionSchema[];
	/** At least one of these options must be written. */
	readonly requiresOneOf?: readonly string[];
	/** Pairs of options that cannot appear together. */
	readonly conflicts?: readonly (readonly [string, string])[];
}

const orientation: SchematicEnumOption = { name: 'orientation', type: 'enum', values: SCHEMATIC_ORIENTATIONS, default: 'right' };
const fit: SchematicEnumOption = { name: 'fit', type: 'enum', values: ['wires'] };
const FIT_CONFLICT = [['fit', 'orientation']] as const;

const variant = (values: readonly string[], fallback: string): SchematicEnumOption => ({ name: 'type', type: 'enum', values, default: fallback });
const count = (name: string, fallback: number, min = 1, max = 32, defaultsByType?: Readonly<Record<string, number>>): SchematicNumberOption => ({
	name,
	type: 'integer',
	min,
	max,
	default: fallback,
	...(defaultsByType === undefined ? {} : { defaultsByType })
});
const busWidth = (fallback: number, min: number): SchematicNumberOption => ({ name: 'width', type: 'integer', min, max: 256, default: fallback });
const dimension = (name: string): SchematicNumberOption => ({ name, type: 'number', min: 24, max: 2048 });
const rows = (name: string): SchematicRowsOption => ({ name, type: 'rows', maxItems: 64, maxLength: 256 });
const pins = (name: string): SchematicPinsOption => ({ name, type: 'pins', maxItems: 64, pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$', reserved: ['in', 'out'] });
const text = (name: string, minLength = 0, maxLength?: number): SchematicTextOption => ({ name, type: 'text', minLength, ...(maxLength === undefined ? {} : { maxLength }) });

const schemas: Partial<Record<ComponentKind, Omit<SchematicComponentSchema, 'kind'>>> = {};
const define = (kinds: readonly string[], family: SchematicComponentFamily, options: readonly SchematicOptionSchema[], extra: Partial<SchematicComponentSchema> = {}) => {
	for (const kind of kinds) schemas[kind as ComponentKind] = { family, options, ...extra };
};

/* ---- electrical ---- */
define(['resistor'], 'electrical', [variant(['fixed', 'variable', 'rheostat', 'potentiometer', 'thermistor', 'ldr'], 'fixed'), orientation]);
define(['capacitor'], 'electrical', [variant(['fixed', 'variable', 'polarized'], 'fixed'), orientation]);
define(['inductor'], 'electrical', [variant(['fixed', 'coupled', 'transformer'], 'fixed'), orientation]);
define(['diode'], 'electrical', [variant(DIODE_TYPES, 'standard'), orientation]);
define(['transistor'], 'electrical', [variant(TRANSISTOR_TYPES, 'npn'), orientation]);
define(['port'], 'electrical', [busWidth(1, 1), orientation]);
define(['ground'], 'electrical', [{ name: 'style', type: 'enum', values: GROUND_STYLES, default: 'signal' }, orientation]);
define(['junction', 'testpoint'], 'electrical', []);
define(['connector'], 'electrical', [orientation]);
for (const [kind, values, fallback] of [
	['source', SOURCE_TYPES, 'voltage-dc'],
	['power', POWER_TYPES, 'vcc'],
	['switch', SWITCH_TYPES, 'spst'],
	['protection', PROTECTION_TYPES, 'fuse'],
	['amplifier', AMPLIFIER_TYPES, 'opamp'],
	['resonator', RESONATOR_TYPES, 'crystal'],
	['meter', METER_TYPES, 'voltmeter'],
	['load', LOAD_TYPES, 'lamp']
] as const) {
	define([kind], 'electrical', [variant(values, fallback), orientation]);
}
define(['ic'], 'electrical', [pins('left'), pins('right'), pins('top'), pins('bottom'), orientation, fit], {
	requiresOneOf: ['left', 'right', 'top', 'bottom'],
	conflicts: FIT_CONFLICT
});

/* ---- digital ---- */
for (const kind of CLASSICAL_GATE_KINDS) {
	define([kind], 'digital', [count('inputs', kind === 'not' ? 1 : 2), count('outputs', 1), { name: 'standard', type: 'enum', values: ['ieee', 'iec'], default: 'ieee' }, orientation]);
}
define(['buffer'], 'digital', [variant(BUFFER_TYPES, 'plain'), count('inputs', 1, 1, 1), count('outputs', 1, 1, 1), orientation]);
define(['logic'], 'digital', [variant(LOGIC_STATES, 'low'), count('outputs', 1, 1, 1), orientation]);
define(['clock'], 'digital', [count('outputs', 1, 1, 1), orientation]);
const block = (inputs: SchematicNumberOption, outputs: SchematicNumberOption, ...more: SchematicOptionSchema[]) => [...more, inputs, outputs, orientation, fit];
define(['flipflop'], 'digital', block(count('inputs', 3), count('outputs', 2), variant(FLIPFLOP_TYPES, 'd')), { conflicts: FIT_CONFLICT });
define(['mux'], 'digital', block(count('inputs', 2, 1, 32, { demux: 1 }), count('outputs', 1, 1, 32, { demux: 2 }), variant(MUX_TYPES, 'mux')), { conflicts: FIT_CONFLICT });
define(['encoder'], 'digital', block(count('inputs', 4), count('outputs', 2)), { conflicts: FIT_CONFLICT });
define(['decoder'], 'digital', block(count('inputs', 2), count('outputs', 4)), { conflicts: FIT_CONFLICT });
define(['register'], 'digital', [...block(count('inputs', 3), count('outputs', 2)), busWidth(8, 1)], { conflicts: FIT_CONFLICT });
define(['counter'], 'digital', block(count('inputs', 3), count('outputs', 2)), { conflicts: FIT_CONFLICT });
define(['adder'], 'digital', block(count('inputs', 2, 1, 32, { full: 3 }), count('outputs', 2), variant(ADDER_TYPES, 'half')), { conflicts: FIT_CONFLICT });
define(['comparator'], 'digital', block(count('inputs', 2), count('outputs', 3)), { conflicts: FIT_CONFLICT });
define(['bus'], 'digital', [...block(count('inputs', 1), count('outputs', 2, 1, 32, { joiner: 1 }), variant(BUS_TYPES, 'splitter')), busWidth(8, 2)], {
	conflicts: FIT_CONFLICT
});

/* ---- quantum ---- */
define(['hadamard'], 'quantum', [orientation]);
define(['qgate', ...NAMED_QUANTUM_GATE_KINDS], 'quantum', [text('parameter'), text('phase'), text('matrix'), orientation]);
define(['cnot'], 'quantum', [orientation, fit], { conflicts: FIT_CONFLICT });
define(['measure', 'reset', 'prepare', 'classical-bit'], 'quantum', [orientation]);
define(['control'], 'quantum', [{ name: 'control', type: 'enum', values: ['positive', 'negative', 'classical'], default: 'positive' }, orientation]);
define(['controlled'], 'quantum', [
	{ name: 'control', type: 'enum', values: ['positive', 'negative', 'classical'], default: 'positive' },
	text('operator'),
	count('controls', 1),
	count('targets', 1),
	orientation,
	fit
], { conflicts: FIT_CONFLICT });
define(['cz', 'cphase'], 'quantum', [count('controls', 1), count('targets', 1), orientation, fit], { conflicts: FIT_CONFLICT });
define(['toffoli'], 'quantum', [count('controls', 2), count('targets', 1), orientation, fit], { conflicts: FIT_CONFLICT });
/* A swap has no controls unless it is given some; the count still starts at 1. */
define(['swap'], 'quantum', [count('controls', 0), count('targets', 2), orientation, fit], { conflicts: FIT_CONFLICT });
define(['barrier', 'delay'], 'quantum', [count('wires', 2), orientation, fit], { conflicts: FIT_CONFLICT });
define(['classical-register'], 'quantum', [busWidth(8, 2), orientation]);

/* ---- UML ---- */
define(['class', 'interface', 'enumeration', 'datatype', 'object'], 'uml', [rows('attributes'), rows('operations'), text('stereotype', 1, 128), dimension('width')]);
define(['state'], 'uml', [rows('details'), dimension('width')]);
define(['history'], 'uml', [{ name: 'type', type: 'enum', values: ['shallow', 'deep'], default: 'shallow' }]);
define(
	[
		'usecase', 'lifeline', 'note', 'package', 'component', 'artifact', 'node', 'device', 'execution', 'system',
		'action', 'object-node', 'partition', 'activation', 'fragment', 'interaction', 'region'
	],
	'uml',
	[dimension('width'), dimension('height')]
);
define(
	[
		'actor', 'provided-interface', 'required-interface', 'component-port', 'decision', 'merge', 'fork', 'join',
		'activity-final', 'flow-final', 'send-signal', 'receive-signal', 'destruction', 'gate', 'found', 'lost',
		'choice', 'state-junction', 'entry', 'exit', 'terminate', 'initial', 'final'
	],
	'uml',
	[]
);

/** Every kind's schema, keyed by kind, in the order of `COMPONENT_KINDS`. */
export const SCHEMATIC_COMPONENT_SCHEMAS: Readonly<Record<ComponentKind, SchematicComponentSchema>> = Object.freeze(
	Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, Object.freeze({ kind, ...schemas[kind]! })]))
) as Readonly<Record<ComponentKind, SchematicComponentSchema>>;

/**
 * The canonical terminals a part of this kind has, with these options.
 *
 * Ports depend on options, such as a gate's `inputs` or a switch's `type`, so
 * they are asked of the parser itself and never listed by hand. Options are
 * validated exactly as in a document, and a bad one throws the same
 * `SchematicSyntaxError` a compilation would.
 */
export function describeComponentPorts(kind: string, options: Readonly<Record<string, string>> = {}): readonly string[] {
	const definition = KINDS[kind];
	if (definition === undefined) throw new SchematicSyntaxError(`Unsupported component kind ${kind}.`, undefined, undefined, 'reference');
	let component;
	try {
		component = definition.parse(kind, { id: 'X', label: '', x: 0, y: 0, color: { kind: 'token', value: 'slate' }, line: 1 }, new Map(Object.entries(options)), 1);
	} catch (error) {
		/* The parser speaks of line 1; there is no document here, so the line goes. */
		const failure = error as SchematicSyntaxError;
		throw new SchematicSyntaxError(failure.message.replace(/^Line 1: /, ''), undefined, undefined, failure.code);
	}
	return definition.ports(component).map((port) => port.id);
}
