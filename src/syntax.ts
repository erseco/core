/**
 * Hand-written lexical layer of the DSL.
 *
 * Every declaration is one line, and every line is read by a character scanner
 * rather than a regular expression: a scanner is linear in the line by
 * construction, so no input can make it backtrack, and it knows where each token
 * starts, which is what lets a diagnostic point at a column instead of a line.
 *
 * The scanner accepts exactly the language the 0.x regular expressions did, so a
 * document that compiled before is read the same way.
 *
 * @module
 */
import {
	SEMANTIC_COLORS,
	SCHEMATIC_SIGNAL_KINDS,
	SCHEMATIC_SIGNAL_MARKERS,
	SchematicSyntaxError,
	UML_RELATION_KINDS,
	type SchematicColor,
	type SchematicPlacementRelation,
	type SchematicRelationKind,
	type SchematicSignalKind,
	type SchematicSignalMarker
} from './types.js';
import { includesValue } from './symbols/common.js';

/** Whether a UTF-16 code unit is whitespace in the sense of `\s`. */
export function isSpace(code: number): boolean {
	return (
		code === 32 ||
		(code >= 9 && code <= 13) ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

/** End of an identifier `[A-Za-z][A-Za-z0-9_-]*` starting at `index`, or -1. */
export function scanIdentifier(text: string, index: number): number {
	if (!isLetter(text.charCodeAt(index))) return -1;
	let cursor = index + 1;
	for (;;) {
		const code = text.charCodeAt(cursor);
		if (isLetter(code) || isDigit(code) || code === 95 || code === 45) cursor += 1;
		else return cursor;
	}
}

/** End of a port name `[A-Za-z][A-Za-z0-9_+-]*` starting at `index`, or -1. */
export function scanPort(text: string, index: number): number {
	if (!isLetter(text.charCodeAt(index))) return -1;
	let cursor = index + 1;
	for (;;) {
		const code = text.charCodeAt(cursor);
		if (isLetter(code) || isDigit(code) || code === 95 || code === 45 || code === 43) cursor += 1;
		else return cursor;
	}
}

/** End of a run of one or more whitespace characters, or -1. */
function scanSpaces(text: string, index: number): number {
	let cursor = index;
	while (cursor < text.length && isSpace(text.charCodeAt(cursor))) cursor += 1;
	return cursor === index ? -1 : cursor;
}

/** End of a decimal `-?\d+(\.\d+)?`, or -1. */
function scanNumber(text: string, index: number): number {
	let cursor = index;
	if (text.charCodeAt(cursor) === 45) cursor += 1;
	const digits = cursor;
	while (isDigit(text.charCodeAt(cursor))) cursor += 1;
	if (cursor === digits) return -1;
	if (text.charCodeAt(cursor) === 46 && isDigit(text.charCodeAt(cursor + 1))) {
		cursor += 1;
		while (isDigit(text.charCodeAt(cursor))) cursor += 1;
	}
	return cursor;
}

/** A token's text and its zero-based column range on the trimmed line. */
export interface Token {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

const token = (text: string, start: number, end: number): Token => ({ text: text.slice(start, end), start, end });

/** `kind:ID "label"` followed by whitespace; the head shared by every component form. */
interface Head {
	readonly kind: Token;
	readonly id: Token;
	readonly label: Token;
	/** Index just after the whitespace following the closing quote. */
	readonly rest: number;
}

function scanHead(text: string): Head | undefined {
	const kindEnd = scanIdentifier(text, 0);
	if (kindEnd < 0 || text.charCodeAt(kindEnd) !== 58) return undefined;
	const idEnd = scanIdentifier(text, kindEnd + 1);
	if (idEnd < 0) return undefined;
	const quote = scanSpaces(text, idEnd);
	if (quote < 0 || text.charCodeAt(quote) !== 34) return undefined;
	const close = text.indexOf('"', quote + 1);
	if (close <= quote + 1) return undefined;
	const rest = scanSpaces(text, close + 1);
	if (rest < 0 || rest >= text.length) return undefined;
	return { kind: token(text, 0, kindEnd), id: token(text, kindEnd + 1, idEnd), label: token(text, quote + 1, close), rest };
}

/** A component declared `kind:ID "label" at (x, y) tail`. */
export interface AbsoluteComponentSyntax {
	readonly form: 'absolute';
	readonly kind: Token;
	readonly id: Token;
	readonly label: Token;
	readonly x: Token;
	readonly y: Token;
	readonly tail: Token;
}

/** A component declared by relation: `kind:ID "label" right-of REF by N tail`. */
export interface RelativeComponentSyntax {
	readonly form: 'relative';
	readonly kind: Token;
	readonly id: Token;
	readonly label: Token;
	readonly relations: readonly SchematicPlacementRelation[];
	readonly tail: Token;
}

/** `A.port -> B.port tail`. */
export interface ConnectionSyntax {
	readonly form: 'connection';
	readonly fromId: Token;
	readonly fromPort: Token;
	readonly toId: Token;
	readonly toPort: Token;
	readonly tail: Token;
}

export type DeclarationSyntax = AbsoluteComponentSyntax | RelativeComponentSyntax | ConnectionSyntax;

/** Read `at (x, y)` then whitespace and a non-empty tail, exactly as the 0.x grammar did. */
function scanAbsolute(text: string, head: Head): AbsoluteComponentSyntax | undefined {
	let cursor = head.rest;
	if (!text.startsWith('at', cursor)) return undefined;
	cursor = scanSpaces(text, cursor + 2);
	if (cursor < 0 || text.charCodeAt(cursor) !== 40) return undefined;
	const xStart = cursor + 1;
	const xEnd = scanNumber(text, xStart);
	if (xEnd < 0 || text.charCodeAt(xEnd) !== 44) return undefined;
	let yStart = xEnd + 1;
	while (yStart < text.length && isSpace(text.charCodeAt(yStart))) yStart += 1;
	const yEnd = scanNumber(text, yStart);
	if (yEnd < 0 || text.charCodeAt(yEnd) !== 41) return undefined;
	const tail = scanSpaces(text, yEnd + 1);
	if (tail < 0 || tail >= text.length) return undefined;
	return {
		form: 'absolute',
		kind: head.kind,
		id: head.id,
		label: head.label,
		x: token(text, xStart, xEnd),
		y: token(text, yStart, yEnd),
		tail: token(text, tail, text.length)
	};
}

const DIRECTIONS = ['right-of', 'left-of', 'above', 'below'] as const;
const ALIGNMENTS = ['aligned-x', 'aligned-y'] as const;

/** Index after one relation separator: whitespace, or the end of the text; -1 otherwise. */
function separator(text: string, index: number): number {
	if (index === text.length) return index;
	return scanSpaces(text, index);
}

/** `REF` or `REF.port`, returning the reference, the port, and the end index. */
function scanReference(text: string, index: number): { ref: string; port?: string; end: number } | undefined {
	const refEnd = scanIdentifier(text, index);
	if (refEnd < 0) return undefined;
	if (text.charCodeAt(refEnd) === 46) {
		const portEnd = scanPort(text, refEnd + 1);
		if (portEnd > 0) return { ref: text.slice(index, refEnd), port: text.slice(refEnd + 1, portEnd), end: portEnd };
	}
	return { ref: text.slice(index, refEnd), end: refEnd };
}

/**
 * Consume a placement clause relation by relation; whatever is left is the tail.
 *
 * Each relation is matched as a bounded prefix, so the clause is linear in its
 * length however many relations it holds.
 */
export function scanPlacement(text: string, start: number): { relations: SchematicPlacementRelation[]; tail: number } {
	const relations: SchematicPlacementRelation[] = [];
	let cursor = start;
	for (;;) {
		const direction = DIRECTIONS.find((kind) => text.startsWith(kind, cursor));
		if (direction !== undefined) {
			const refStart = scanSpaces(text, cursor + direction.length);
			const reference = refStart < 0 ? undefined : scanReference(text, refStart);
			if (reference !== undefined) {
				/* The optional `by N` is tried first and abandoned if it does not
				   complete, exactly as the optional group of the old pattern. */
				let gap: number | undefined;
				let end = reference.end;
				const bySpace = scanSpaces(text, end);
				if (bySpace > 0 && text.startsWith('by', bySpace)) {
					const numberStart = scanSpaces(text, bySpace + 2);
					const numberEnd = numberStart < 0 ? -1 : scanNumber(text, numberStart);
					if (numberEnd > 0 && separator(text, numberEnd) >= 0) {
						gap = Number(text.slice(numberStart, numberEnd));
						end = numberEnd;
					}
				}
				const next = separator(text, end);
				if (next >= 0) {
					relations.push({
						kind: direction,
						ref: reference.ref,
						...(reference.port === undefined ? {} : { port: reference.port }),
						...(gap === undefined ? {} : { gap })
					});
					cursor = next;
					continue;
				}
			}
		}
		const alignment = ALIGNMENTS.find((kind) => text.startsWith(kind, cursor));
		if (alignment !== undefined) {
			const withStart = scanSpaces(text, cursor + alignment.length);
			if (withStart > 0 && text.startsWith('with', withStart)) {
				const refStart = scanSpaces(text, withStart + 4);
				const reference = refStart < 0 ? undefined : scanReference(text, refStart);
				const next = reference === undefined ? -1 : separator(text, reference.end);
				if (reference !== undefined && next >= 0) {
					relations.push({ kind: alignment, ref: reference.ref, ...(reference.port === undefined ? {} : { port: reference.port }) });
					cursor = next;
					continue;
				}
			}
		}
		return { relations, tail: cursor };
	}
}

function scanConnection(text: string): ConnectionSyntax | undefined {
	const fromIdEnd = scanIdentifier(text, 0);
	if (fromIdEnd < 0 || text.charCodeAt(fromIdEnd) !== 46) return undefined;
	let fromPortEnd = scanPort(text, fromIdEnd + 1);
	if (fromPortEnd < 0) return undefined;
	/* A port may end in '-', so `out->` scans as `out-` then `>`. Give the final
	   '-' back to the arrow, as the old pattern did by backtracking. */
	if (text.charCodeAt(fromPortEnd - 1) === 45 && text.charCodeAt(fromPortEnd) === 62 && fromPortEnd - 1 > fromIdEnd + 1) fromPortEnd -= 1;
	let cursor = fromPortEnd;
	while (cursor < text.length && isSpace(text.charCodeAt(cursor))) cursor += 1;
	if (!text.startsWith('->', cursor)) return undefined;
	cursor += 2;
	while (cursor < text.length && isSpace(text.charCodeAt(cursor))) cursor += 1;
	const toIdStart = cursor;
	const toIdEnd = scanIdentifier(text, toIdStart);
	if (toIdEnd < 0 || text.charCodeAt(toIdEnd) !== 46) return undefined;
	const toPortEnd = scanPort(text, toIdEnd + 1);
	if (toPortEnd < 0) return undefined;
	const tail = scanSpaces(text, toPortEnd);
	if (tail < 0 || tail >= text.length) return undefined;
	return {
		form: 'connection',
		fromId: token(text, 0, fromIdEnd),
		fromPort: token(text, fromIdEnd + 1, fromPortEnd),
		toId: token(text, toIdStart, toIdEnd),
		toPort: token(text, toIdEnd + 1, toPortEnd),
		tail: token(text, tail, text.length)
	};
}

/**
 * Classify one trimmed, non-comment line.
 *
 * Tried in the order the 0.x parser tried its patterns: an absolute component,
 * then a relative one (which needs at least one relation and a tail), then a
 * connection. `undefined` is an unrecognized declaration.
 */
export function scanDeclaration(text: string): DeclarationSyntax | undefined {
	const head = scanHead(text);
	if (head !== undefined) {
		const absolute = scanAbsolute(text, head);
		if (absolute !== undefined) return absolute;
		const placement = scanPlacement(text, head.rest);
		if (placement.relations.length > 0 && placement.tail < text.length) {
			return { form: 'relative', kind: head.kind, id: head.id, label: head.label, relations: placement.relations, tail: token(text, placement.tail, text.length) };
		}
	}
	return scanConnection(text);
}

/* ---- declaration tails: colour and bracketed options ---- */

/** A declaration tail split into its paint and its option block. */
export interface DeclarationTail {
	readonly color: string;
	readonly options: string | undefined;
}

/** Split a tail without misreading brackets inside CSS functions or quotes. */
export function splitDeclarationTail(raw: string, line: number, allowMissingColor = false): DeclarationTail {
	const source = raw.trim();
	let quoteOpen = false;
	let parentheses = 0;
	let optionsStart = -1;
	let optionsEnd = -1;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (character === '"') {
			quoteOpen = !quoteOpen;
			continue;
		}
		if (quoteOpen) continue;
		if (character === '(') {
			parentheses += 1;
			continue;
		}
		if (character === ')') {
			parentheses -= 1;
			if (parentheses < 0) throw new SchematicSyntaxError('Malformed declaration tail.', line);
			continue;
		}
		if (character === '[' && parentheses === 0) {
			if (optionsStart >= 0 || (index > 0 && !isSpace(source.charCodeAt(index - 1)))) {
				throw new SchematicSyntaxError('Malformed declaration options.', line);
			}
			optionsStart = index;
			continue;
		}
		if (character === ']' && parentheses === 0) {
			if (optionsStart < 0 || optionsEnd >= 0) throw new SchematicSyntaxError('Malformed declaration options.', line);
			optionsEnd = index;
		}
	}
	if (quoteOpen || parentheses !== 0) throw new SchematicSyntaxError('Malformed declaration tail.', line);
	if (optionsStart < 0) return { color: source, options: undefined };
	if (optionsEnd < optionsStart || source.slice(optionsEnd + 1).trim() !== '') {
		throw new SchematicSyntaxError('Malformed declaration options.', line);
	}
	const color = source.slice(0, optionsStart).trim();
	if (color === '' && !allowMissingColor) throw new SchematicSyntaxError('A declaration color is required.', line);
	return { color, options: source.slice(optionsStart + 1, optionsEnd) };
}

/** Whitespace-separated `key=value` component options; quoted values may hold spaces. */
export function parseAttributes(raw: string | undefined, line: number): ReadonlyMap<string, string> {
	const attributes = new Map<string, string>();
	if (raw === undefined) return attributes;
	const malformed = () => new SchematicSyntaxError('Malformed component options.', line, undefined, 'option');
	if (raw.trim() === '') throw malformed();
	const source = raw.trim();
	let cursor = 0;
	while (cursor < source.length) {
		if (cursor > 0) {
			if (!isSpace(source.charCodeAt(cursor))) throw malformed();
			while (cursor < source.length && isSpace(source.charCodeAt(cursor))) cursor += 1;
		}
		const keyStart = cursor;
		const first = source.charCodeAt(cursor);
		if (first < 97 || first > 122) throw malformed();
		cursor += 1;
		while (cursor < source.length) {
			const code = source.charCodeAt(cursor);
			if (!((code >= 97 && code <= 122) || isDigit(code) || code === 45)) break;
			cursor += 1;
		}
		if (source[cursor] !== '=') throw malformed();
		const key = source.slice(keyStart, cursor);
		cursor += 1;
		let value: string;
		if (source[cursor] === '"') {
			const valueStart = ++cursor;
			while (cursor < source.length && source[cursor] !== '"') cursor += 1;
			/* v8 ignore next -- splitDeclarationTail rejects unbalanced quotes first. */
			if (cursor === source.length) throw malformed();
			value = source.slice(valueStart, cursor);
			cursor += 1;
		} else {
			const valueStart = cursor;
			while (cursor < source.length && !isSpace(source.charCodeAt(cursor))) cursor += 1;
			if (cursor === valueStart) throw malformed();
			value = source.slice(valueStart, cursor);
		}
		if (attributes.has(key)) throw new SchematicSyntaxError(`Duplicate option ${key}.`, line, undefined, 'option');
		attributes.set(key, value);
	}
	return attributes;
}

/* ---- colours ---- */

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const ANGLE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|grad|rad|turn)?$/i;
const ALIAS = /^[a-z][a-z0-9-]{0,63}$/i;

function ranged(value: string, minimum: number, maximum: number, allowPercent: boolean): boolean {
	const percent = allowPercent && value.endsWith('%');
	const numeric = percent ? value.slice(0, -1) : value;
	if (!NUMBER.test(numeric)) return false;
	const parsed = Number(numeric);
	return parsed >= minimum && parsed <= (percent ? 100 : maximum);
}

function functional(name: string, body: string, valid: (channels: readonly string[]) => boolean): string | undefined {
	const comma = body.includes(',');
	const slash = body.split('/').map((part) => part.trim());
	if (slash.length > 2 || (comma && slash.length > 1)) return undefined;
	const parsed = comma ? slash[0]!.split(',').map((part) => part.trim()) : slash[0]!.split(/\s+/);
	const legacyAlpha = comma && parsed.length === 4 ? parsed[3] : undefined;
	const channels = legacyAlpha === undefined ? parsed : parsed.slice(0, 3);
	const alpha = slash.at(1) ?? legacyAlpha;
	if (channels.length !== 3 || !valid(channels) || (alpha !== undefined && !ranged(alpha, 0, 1, true))) return undefined;
	return `${name}(${channels.join(' ')}${alpha === undefined ? '' : ` / ${alpha}`})`;
}

/**
 * Parse a theme token, safe CSS literal, or custom theme alias.
 *
 * @throws {SchematicSyntaxError} For malformed, out-of-range, or unsafe colours.
 */
export function parseSchematicColor(input: string, line = 1): SchematicColor {
	const value = input.trim();
	const candidate = (value.startsWith('#') ? value.slice(1) : value).toLowerCase();
	if (includesValue(SEMANTIC_COLORS, candidate)) return { kind: 'token', value: candidate };
	if (/^#[A-Fa-f0-9]+$/.test(value)) {
		if (![4, 5, 7, 9].includes(value.length)) throw new SchematicSyntaxError('Hex colors require 3, 4, 6, or 8 digits.', line, undefined, 'option');
		return { kind: 'css', value: value.toLowerCase() };
	}
	const call = /^(rgb|rgba|hsl|hsla)\((.*)\)$/i.exec(value);
	if (call !== null) {
		const name = call[1]!.toLowerCase();
		const normalized = name.startsWith('rgb')
			? functional('rgb', call[2]!, (channels) => channels.every((channel) => ranged(channel, 0, 255, true)))
			: functional(
					'hsl',
					call[2]!,
					([hue, saturation, lightness]) =>
						ANGLE.test(hue!) && saturation!.endsWith('%') && ranged(saturation!, 0, 100, true) && lightness!.endsWith('%') && ranged(lightness!, 0, 100, true)
				);
		if (!normalized) throw new SchematicSyntaxError(`Invalid ${name} color.`, line, undefined, 'option');
		return { kind: 'css', value: normalized };
	}
	const alias = value.startsWith('#') ? value.slice(1) : value;
	if (ALIAS.test(alias)) return { kind: 'alias', value: alias.toLowerCase() };
	throw new SchematicSyntaxError('Unsafe or unsupported color expression.', line, undefined, 'option');
}

/* ---- connection options ---- */

/** Normalized routing, marker, relation and topology options of one connection. */
export interface ConnectionOptions {
	curve: 'line' | 'bezier' | 'ortho';
	markerStart: SchematicSignalMarker;
	markerEnd: SchematicSignalMarker;
	relation: SchematicRelationKind;
	label: string | undefined;
	dashed: boolean;
	signalKind: SchematicSignalKind | undefined;
	net: string | undefined;
	width: number | undefined;
	trunk: boolean;
}

/** Split options on whitespace outside quotes. */
export function optionTokens(raw: string, line: number): readonly string[] {
	const tokens: string[] = [];
	let tokenStart = -1;
	let quoteOpen = false;
	for (let index = 0; index <= raw.length; index += 1) {
		const character = raw[index];
		if (character === '"') quoteOpen = !quoteOpen;
		const space = character !== undefined && isSpace(raw.charCodeAt(index));
		if ((character === undefined || (space && !quoteOpen)) && tokenStart >= 0) {
			tokens.push(raw.slice(tokenStart, index));
			tokenStart = -1;
		} else if (character !== undefined && !space && tokenStart < 0) {
			tokenStart = index;
		}
	}
	/* v8 ignore next -- splitDeclarationTail rejects unbalanced quotes before tokenization. */
	if (quoteOpen) throw new SchematicSyntaxError('Malformed quoted connection option.', line, undefined, 'option');
	return tokens;
}

const OPEN_ENDED = new Set(['dependency', 'message', 'asynchronous', 'return', 'control-flow', 'object-flow', 'transition', 'include', 'extend']);

/** Parse a connection's option block without duplicate declarations. */
export function parseConnectionOptions(raw: string | undefined, line: number): ConnectionOptions {
	const options: ConnectionOptions = {
		curve: 'line',
		markerStart: 'none',
		markerEnd: 'none',
		relation: 'signal',
		label: undefined,
		dashed: false,
		signalKind: undefined,
		net: undefined,
		width: undefined,
		trunk: false
	};
	const fail = (message: string) => new SchematicSyntaxError(message, line, undefined, 'option');
	const seen = new Set<string>();
	if (raw !== undefined && raw.trim() !== '') {
		for (const token of optionTokens(raw.trim(), line)) {
			if (token === 'line' || token === 'bezier' || token === 'ortho') {
				if (seen.has('curve')) throw fail('Connection routing can only be declared once.');
				options.curve = token;
				seen.add('curve');
				continue;
			}
			if (token === 'dashed' || token === 'solid') {
				if (seen.has('stroke-style')) throw fail('Connection stroke style can only be declared once.');
				options.dashed = token === 'dashed';
				seen.add('stroke-style');
				continue;
			}
			if (includesValue(UML_RELATION_KINDS, token)) {
				if (seen.has('relation')) throw fail('Connection relation can only be declared once.');
				options.relation = token;
				seen.add('relation');
				continue;
			}
			if (includesValue(SCHEMATIC_SIGNAL_KINDS, token)) {
				if (seen.has('signal')) throw fail('Connection signal kind can only be declared once.');
				options.signalKind = token;
				seen.add('signal');
				continue;
			}
			if (token === 'trunk') {
				if (options.trunk) throw fail('Connection trunk can only be declared once.');
				options.trunk = true;
				continue;
			}
			if (token === 'arrow' || token === 'dot') {
				if (seen.has('marker-end')) throw fail('Connection marker-end can only be declared once.');
				options.markerEnd = token;
				seen.add('marker-end');
				continue;
			}
			const match = /^(marker-start|marker-end|relation|label|signal|net|width)=(.*)$/.exec(token);
			if (match === null) throw fail('Unsupported connection routing, topology, marker, relation, label, or stroke option.');
			const option = match[1]!;
			if (seen.has(option)) throw fail(`Connection ${option} can only be declared once.`);
			let value = match[2]!;
			if (value.startsWith('"') || value.endsWith('"')) {
				if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) throw fail(`Malformed connection ${option}.`);
				value = value.slice(1, -1);
			}
			if (option === 'relation') {
				if (!includesValue(UML_RELATION_KINDS, value)) throw fail(`relation must be one of: ${UML_RELATION_KINDS.join(', ')}.`);
				options.relation = value;
			} else if (option === 'label') {
				if (value === '' || value.length > 256) throw fail('Connection labels require 1 through 256 characters.');
				options.label = value;
			} else if (option === 'signal') {
				if (!includesValue(SCHEMATIC_SIGNAL_KINDS, value)) throw fail(`signal must be one of: ${SCHEMATIC_SIGNAL_KINDS.join(', ')}.`);
				options.signalKind = value;
			} else if (option === 'net') {
				if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
					throw fail('net must begin with a letter and contain at most 64 letters, digits, underscores, or hyphens.');
				}
				options.net = value;
			} else if (option === 'width') {
				if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 256) throw fail('width must be an integer from 1 through 256.');
				options.width = Number(value);
			} else {
				if (!includesValue(SCHEMATIC_SIGNAL_MARKERS, value)) throw fail(`${option} must be one of: ${SCHEMATIC_SIGNAL_MARKERS.join(', ')}.`);
				if (option === 'marker-start') options.markerStart = value;
				else options.markerEnd = value;
			}
			seen.add(option);
		}
	}
	if (!seen.has('marker-start')) {
		if (options.relation === 'aggregation') options.markerStart = 'diamond';
		else if (options.relation === 'composition') options.markerStart = 'diamond-filled';
	}
	if (!seen.has('marker-end')) {
		if (options.relation === 'generalization' || options.relation === 'realization') options.markerEnd = 'triangle';
		else if (OPEN_ENDED.has(options.relation)) options.markerEnd = 'open-arrow';
		else if (options.relation === 'synchronous') options.markerEnd = 'arrow';
	}
	if (!seen.has('stroke-style')) options.dashed = ['dependency', 'realization', 'return', 'include', 'extend'].includes(options.relation);
	if (options.label === undefined && (options.relation === 'include' || options.relation === 'extend')) options.label = `«${options.relation}»`;
	return options;
}
