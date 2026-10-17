/**
 * Shared vocabulary of the symbol registry.
 *
 * A component kind is declared once, as a {@link KindDef}: how its options are
 * read, how big its body is, where its terminals are and what every accepted
 * spelling of them means, how it is drawn, and which text stays upright when it
 * turns. Validation, port resolution, canonical naming, collision bounds and the
 * SVG all read that one record, so they cannot disagree about a symbol.
 *
 * All geometry here is in integer milli-units in the symbol's own unrotated
 * frame; the layout module applies orientation and position.
 *
 * @module
 */
import { fmt, roundDiv, toMilli } from '../geom.js';
import { mathLabelTextWidth } from '../math-label.js';
import { escapeXml } from '../xml.js';
import {
	SCHEMATIC_ORIENTATIONS,
	SchematicSyntaxError,
	type SchematicColor,
	type SchematicComponent,
	type SchematicOrientation
} from '../types.js';

/** One terminal in the symbol's own frame: position and outward normal. */
export interface LocalPort {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly nx: number;
	readonly ny: number;
}

/** Identity, position, label and paint every declaration carries. */
export interface CommonFields {
	readonly id: string;
	readonly label: string;
	readonly x: number;
	readonly y: number;
	readonly color: SchematicColor;
	readonly line: number;
}

/** Everything the compiler knows about one component kind. */
export interface KindDef<C extends SchematicComponent = SchematicComponent> {
	/** Read a declaration's options into its AST node, or throw with the line. */
	readonly parse: (kind: string, common: CommonFields, options: ReadonlyMap<string, string>, line: number) => C;
	/** Body half-extents in the unrotated frame, terminal stubs included. */
	readonly extents: (component: C) => readonly [number, number];
	/** Each physical terminal once, in stable order. */
	readonly ports: (component: C) => readonly LocalPort[];
	/** Any accepted spelling of a terminal, or `undefined` when it is not one. */
	readonly resolve: (component: C, name: string) => LocalPort | undefined;
	/** Vectors in the unrotated frame. */
	readonly draw: (component: C, paint: string, nodePaint: string) => string;
	/** Glyphs drawn after rotation so they stay upright. */
	readonly inner?: (component: C) => string;
	/** Key under which identical geometry is shared through `<use>`, if any. */
	readonly symbol?: (component: C) => string | undefined;
}

/** Text paint that never inherits a vector stroke. */
export const TEXT_PAINT = 'fill="currentColor" stroke="none"';
/** `textLength` fitting policy for width-clamped labels. */
export const LENGTH_FIT = 'lengthAdjust="spacingAndGlyphs"';

/** Format a milli-unit value. */
export const n = fmt;

/** Format a value computed in diagram units (a text width, a curve sample). */
export function u(value: number): string {
	return fmt(toMilli(value));
}

/** Milli-units of a text run at `advance` units per glyph. */
export function textWidth(value: string, advance: number): number {
	return toMilli(mathLabelTextWidth(value, advance));
}

/** Even distribution of `count` terminals across a centred `span`, in milli-units. */
export function distributed(index: number, count: number, span: number): number {
	return roundDiv((index + 1) * span * 2 - span * (count + 1), 2 * (count + 1));
}

/** A terminal at `(x, y)` in diagram units with outward normal `(nx, ny)`. */
export function port(id: string, x: number, y: number, nx: number, ny: number): LocalPort {
	return { id, x: x * 1000, y: y * 1000, nx, ny };
}

/** The same terminal under another name. */
export function named(source: LocalPort, id: string): LocalPort {
	return { ...source, id };
}

/** Bounded `textLength` for a fitted label, in diagram units. */
export function fittedTextLength(value: string, maximum: number, advance: number): number {
	return Math.max(1, Math.min(Math.ceil(mathLabelTextWidth(value, advance)), maximum));
}

/** Class, fill and safe style attributes for one colour. */
export function colorAttributes(color: SchematicColor, extraClass = ''): string {
	const suffix = extraClass === '' ? '' : ` ${extraClass}`;
	const fill = extraClass.split(' ').includes('schematic-node-fill') ? ' fill="currentColor"' : '';
	if (color.kind === 'token') return `class="schematic-token schematic-token--${color.value}${suffix}"${fill}`;
	if (color.kind === 'css') {
		return `class="schematic-token schematic-token--custom${suffix}"${fill} style="color:${escapeXml(color.value)};--schematic-vector:${escapeXml(color.value)}"`;
	}
	const safe = color.value.replace(/[^a-z0-9-]/gi, '-');
	return `class="schematic-token schematic-token--alias schematic-color--${safe}${suffix}"${fill} style="color:var(--schematic-color-${safe},var(--schematic-vector-fallback,currentColor));--schematic-vector:var(--schematic-color-${safe},var(--schematic-vector-fallback,currentColor))"`;
}

/* ---- option reading ---- */

/** Membership in a readonly string tuple, narrowing to its literal union. */
export function includesValue<const T extends readonly string[]>(values: T, value: string): value is T[number] {
	return values.includes(value);
}

/** Reject any option a kind does not support. */
export function only(options: ReadonlyMap<string, string>, allowed: readonly string[], line: number): void {
	for (const key of options.keys()) {
		if (!allowed.includes(key)) throw new SchematicSyntaxError(`Option ${key} is not supported.`, line);
	}
}

/** One allow-listed option with a default. */
export function enumOption<const T extends readonly string[]>(
	value: string | undefined,
	fallback: T[number],
	values: T,
	name: string,
	line: number
): T[number] {
	if (value === undefined) return fallback;
	if (!includesValue(values, value)) {
		throw new SchematicSyntaxError(`Option ${name} must be one of: ${values.join(', ')}.`, line);
	}
	return value;
}

/** A terminal count from 1 through 32. */
export function count(value: string | undefined, fallback: number, name: string, line: number): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 32) {
		throw new SchematicSyntaxError(`${name} must be an integer from 1 through 32.`, line);
	}
	return Number(value);
}

/** A scalar or bus width from 1 through 256. */
export function width(value: string | undefined, fallback: number, line: number): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 256) {
		throw new SchematicSyntaxError('width must be an integer from 1 through 256.', line);
	}
	return Number(value);
}

/** An optional orientation, materialised only when the author wrote one. */
export function orientation(options: ReadonlyMap<string, string>, line: number): { orientation?: SchematicOrientation } {
	const value = options.get('orientation');
	return value === undefined ? {} : { orientation: enumOption(value, 'right', SCHEMATIC_ORIENTATIONS, 'orientation', line) };
}

/** Indexed `inN`/`outN` terminal, with `in`/`out` meaning the first. */
export function indexed(name: string, inputs: number, outputs: number): { output: boolean; index: number } | undefined {
	if (name === 'in') return inputs > 0 ? { output: false, index: 0 } : undefined;
	if (name === 'out') return outputs > 0 ? { output: true, index: 0 } : undefined;
	const match = /^(in|out)([1-9]\d*)$/.exec(name);
	if (match === null) return undefined;
	const index = Number(match[2]) - 1;
	const output = match[1] === 'out';
	return index < (output ? outputs : inputs) ? { output, index } : undefined;
}

/** Look a terminal up by exact canonical name. */
export function byName(ports: readonly LocalPort[], name: string): LocalPort | undefined {
	return ports.find((entry) => entry.id === name);
}
