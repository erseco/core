/**
 * Dependency-free micro-math tokenizer and inline SVG text renderer.
 *
 * The grammar is intentionally non-recursive and bounded by the caller's label
 * length. It recognizes subscript/superscript shifts and a fixed engineering
 * symbol map without evaluating TeX or allocating a browser-side math runtime.
 *
 * @packageDocumentation
 */

import { fromMilli, toMilli } from './geom.js';
import { escapeXml } from './xml.js';

/** Visual baseline category assigned to one parsed label segment. */
export type MathLabelSegmentKind = 'text' | 'subscript' | 'superscript';

/** One normalized, Unicode-translated section of a component label. */
export interface MathLabelSegment {
	/** Baseline treatment used by the SVG renderer. */
	readonly kind: MathLabelSegmentKind;
	/** Plain Unicode content with grouping delimiters removed. */
	readonly value: string;
	/** Absolute font scale for nested scripts; omitted for normal and first-level runs. */
	readonly fontScale?: number;
	/** Absolute baseline shift in parent em units for nested scripts. */
	readonly baselineShiftEm?: number;
}

/** Parser-owned mutable form used to coalesce runs without repeated object cloning. */
interface MutableMathLabelSegment {
	kind: MathLabelSegmentKind;
	value: string;
	fontScale?: number;
	baselineShiftEm?: number;
}

/** Fixed command-to-Unicode allowlist; unknown commands remain literal text. */
const MATH_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
	alpha: 'α',
	beta: 'β',
	Delta: 'Δ',
	cdot: '·',
	infty: '∞',
	lambda: 'λ',
	langle: '⟨',
	le: '≤',
	ge: '≥',
	mu: 'μ',
	neq: '≠',
	Omega: 'Ω',
	omega: 'ω',
	oplus: '⊕',
	phi: 'φ',
	pi: 'π',
	pm: '±',
	rangle: '⟩',
	rightarrow: '→',
	sigma: 'σ',
	sqrt: '√',
	theta: 'θ',
	times: '×'
});

/**
 * Resolve the backslash command beginning at an exact string offset.
 *
 * @param value - Complete source label.
 * @param index - Offset of the command's backslash.
 * @returns Unicode replacement text and the first unread offset.
 */
function commandAt(value: string, index: number): { readonly text: string; readonly end: number } {
	const escaped = value[index + 1];
	if (
		escaped === '\\' ||
		escaped === '{' ||
		escaped === '}' ||
		escaped === '_' ||
		escaped === '^'
	) {
		return { text: escaped, end: index + 2 };
	}
	let end = index + 1;
	while (end < value.length) {
		const code = value.charCodeAt(end);
		if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) break;
		end += 1;
	}
	if (end === index + 1) return { text: '\\', end: index + 1 };
	const command = value.slice(index + 1, end);
	const replacement = MATH_SYMBOLS[command];
	return {
		text: replacement ?? `\\${command}`,
		end
	};
}

/**
 * Append a segment while coalescing adjacent runs with the same baseline.
 *
 * @param segments - Mutable parser-owned output list.
 * @param kind - Baseline category of the new run.
 * @param value - Unicode-translated content; empty strings are ignored.
 */
function appendSegment(
	segments: MutableMathLabelSegment[],
	kind: MathLabelSegmentKind,
	value: string,
	fontScale: number,
	baselineShiftEm: number
): void {
	const previous = segments.at(-1);
	const previousScale = previous?.fontScale ?? (previous?.kind === 'text' ? 1 : 0.7);
	const previousShift =
		previous?.baselineShiftEm ??
		(previous?.kind === 'subscript' ? 0.35 : previous?.kind === 'superscript' ? -0.55 : 0);
	if (
		previous?.kind === kind &&
		previousScale === fontScale &&
		previousShift === baselineShiftEm
	) {
		previous.value += value;
		return;
	}
	const nested = fontScale !== (kind === 'text' ? 1 : 0.7) ||
		baselineShiftEm !== (kind === 'subscript' ? 0.35 : kind === 'superscript' ? -0.55 : 0);
	segments.push(
		nested ? { kind, value, fontScale, baselineShiftEm } : { kind, value }
	);
}

/**
 * Parse a deliberately small, linear-time math-label subset.
 *
 * @param value - Raw component label. Braces only group shifted content.
 * @returns Coalesced immutable baseline segments with symbol commands expanded.
 */
export function parseMathLabel(value: string): readonly MathLabelSegment[] {
	const cached = parsed.get(value);
	if (cached !== undefined) return cached;
	const segments = Object.freeze(parse(value).map((segment) => Object.freeze(segment)));
	/* A compile asks about each label several times — width, text, markup — so
	   parses are kept; the cache is dropped whole rather than grown past a bound. */
	if (parsed.size >= PARSE_CACHE_LIMIT) parsed.clear();
	parsed.set(value, segments);
	return segments;
}

const PARSE_CACHE_LIMIT = 1024;
const parsed = new Map<string, readonly MathLabelSegment[]>();

function parse(value: string): readonly MathLabelSegment[] {
	const segments: MutableMathLabelSegment[] = [];
	const braceStack: number[] = [];
	const matchingBraces = new Map<number, number>();
	const matchedClosings = new Set<number>();
	for (let cursor = 0; cursor < value.length; cursor += 1) {
		if (value[cursor] === '\\') {
			cursor += 1;
			continue;
		}
		if (value[cursor] === '{') braceStack.push(cursor);
		else if (value[cursor] === '}') {
			const opening = braceStack.pop();
			if (opening !== undefined) {
				matchingBraces.set(opening, cursor);
				matchedClosings.add(cursor);
			}
		}
	}
	interface Context {
		readonly end: number;
		readonly kind: MathLabelSegmentKind;
		readonly fontScale: number;
		readonly baselineShiftEm: number;
	}
	const contexts: Context[] = [
		{ end: value.length, kind: 'text', fontScale: 1, baselineShiftEm: 0 }
	];
	let index = 0;
	while (index < value.length) {
		const context = contexts[contexts.length - 1]!;
		if (index === context.end) {
			contexts.pop();
			index += 1;
			continue;
		}
		const character = value[index]!;
		if (matchingBraces.has(index) || matchedClosings.has(index)) {
			index += 1;
			continue;
		}
		if ((character === '_' || character === '^') && index + 1 < value.length) {
			const kind = character === '_' ? 'subscript' : 'superscript';
			const fontScale = context.fontScale * 0.7;
			const baselineShiftEm =
				context.baselineShiftEm +
				(character === '_' ? 0.35 * context.fontScale : -0.55 * context.fontScale);
			if (value[index + 1] === '{') {
				const closing = matchingBraces.get(index + 1);
				if (closing !== undefined) {
					contexts.push({ end: closing, kind, fontScale, baselineShiftEm });
					index += 2;
					continue;
				}
				appendSegment(
					segments,
					context.kind,
					character,
					context.fontScale,
					context.baselineShiftEm
				);
				index += 1;
				continue;
			}
			let token: { readonly text: string; readonly end: number };
			if (value[index + 1] === '\\') token = commandAt(value, index + 1);
			else {
				const codePoint = value.codePointAt(index + 1)!;
				const text = String.fromCodePoint(codePoint);
				token = { text, end: index + 1 + text.length };
			}
			appendSegment(segments, kind, token.text, fontScale, baselineShiftEm);
			index = token.end;
			continue;
		}
		if (character === '\\') {
			const command = commandAt(value, index);
			appendSegment(
				segments,
				context.kind,
				command.text,
				context.fontScale,
				context.baselineShiftEm
			);
			index = command.end;
			continue;
		}
		const codePoint = value.codePointAt(index)!;
		const text = String.fromCodePoint(codePoint);
		appendSegment(
			segments,
			context.kind,
			text,
			context.fontScale,
			context.baselineShiftEm
		);
		index += text.length;
	}
	return segments;
}

/**
 * Return the accessible plain-text representation of a math label.
 *
 * @param value - Raw micro-math label.
 * @returns Unicode text without baseline grouping markup.
 */
export function mathLabelText(value: string): string {
	return parseMathLabel(value)
		.map((segment) => segment.value)
		.join('');
}

/**
 * Count rendered Unicode glyphs for deterministic SVG text fitting.
 *
 * @param value - Raw micro-math label.
 * @returns Unicode code-point count after command translation.
 */
export function mathLabelGlyphLength(value: string): number {
	let length = 0;
	for (const _character of mathLabelText(value)) length += 1;
	return length;
}

/**
 * The font every width here is measured for. Arial, Helvetica, Liberation Sans
 * and Arimo share these advances, so the estimate is the rendered width in any
 * of them; the compiled SVG names this stack as its default.
 */
export const MATH_LABEL_FONT_FAMILY = "Arial, Helvetica, 'Liberation Sans', Arimo, sans-serif";

/* Advances of the printable ASCII range, in hundredths of an em, measured from
   Arial in Chromium; they match the published Helvetica metrics. */
const ASCII_ADVANCE = [
	28, 28, 36, 56, 56, 89, 67, 19, 33, 33, 39, 58, 28, 33, 28, 28, 56, 56, 56, 56, 56, 56, 56, 56, 56, 56, 28, 28, 58, 58, 58, 56, 102, 67, 67, 72, 72,
	67, 61, 78, 72, 28, 50, 67, 56, 83, 72, 78, 67, 78, 72, 67, 61, 72, 67, 94, 67, 67, 61, 28, 28, 28, 47, 56, 33, 56, 56, 50, 56, 56, 28, 56, 56, 22,
	22, 50, 22, 83, 56, 56, 56, 56, 33, 50, 28, 56, 50, 72, 50, 50, 50, 33, 26, 33, 58
];
/* The symbols a label is likely to hold beyond ASCII whose width differs from a
   digit's, measured the same way; the rest are within 0.02 em of one. */
const SYMBOL_ADVANCE: Readonly<Record<string, number>> = Object.freeze({
	Δ: 67, '·': 33, '∞': 71, λ: 50, Ω: 75, ω: 78, φ: 65, π: 69, Σ: 62, '→': 100, σ: 62, '°': 40, '²': 33, '³': 33, '⊕': 72, '⟩': 37, '⟨': 37, '—': 100, '…': 100
});
/** Bold widens Arial's letters and digits by this much on average. */
const BOLD_FACTOR = 1.043;

/** One code point's advance in em. */
function advance(character: string, codePoint: number): number {
	if (codePoint >= 32 && codePoint < 127) return ASCII_ADVANCE[codePoint - 32]! / 100;
	const symbol = SYMBOL_ADVANCE[character];
	if (symbol !== undefined) return symbol / 100;
	if (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
		codePoint === 0x200d
	) {
		return 0;
	}
	if (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			(codePoint >= 0x2329 && codePoint <= 0x232a) ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1faff))
	) {
		return 1;
	}
	/* An accented Latin letter is as wide as its base letter. */
	const base = character.normalize('NFD').charCodeAt(0);
	return base >= 32 && base < 127 ? ASCII_ADVANCE[base - 32]! / 100 : 0.56;
}

/**
 * Rendered width of a math label at a font size, in viewBox units.
 *
 * Measured advances for the stack in {@link MATH_LABEL_FONT_FAMILY}, scripts at
 * their parsed scale; combining marks take no width and East Asian and emoji
 * code points one em. Kerning is ignored; the result is exact to the
 * milli-unit.
 *
 * @param value - Raw micro-math label.
 * @param fontSize - Font size in viewBox units.
 * @param bold - Whether the text is set bold.
 */
export function mathLabelTextWidthAt(value: string, fontSize: number, bold = false): number {
	let em = 0;
	for (const segment of parseMathLabel(value)) {
		const scale = segment.fontScale ?? (segment.kind === 'text' ? 1 : 0.7);
		for (const character of segment.value) em += advance(character, character.codePointAt(0)!) * scale;
	}
	/* Rounded to the milli-unit every geometry downstream works in. */
	return fromMilli(toMilli(em * fontSize * (bold ? BOLD_FACTOR : 1)));
}

/**
 * Rendered width of a math label, in viewBox units.
 *
 * @param value - Raw micro-math label.
 * @param cellAdvance - The advance of an average glyph: 7 is 12-unit text, and
 *   other values scale the font size in proportion.
 * @returns The width at a font size of `cellAdvance * 12 / 7`.
 */
export function mathLabelTextWidth(value: string, cellAdvance = 7): number {
	return mathLabelTextWidthAt(value, (cellAdvance * 12) / 7);
}

/**
 * Emit escaped inline SVG text with explicit baseline restoration.
 *
 * Baseline shifts are tracked in root-em units, but SVG resolves a `<tspan>`'s
 * `dy="…em"` against *that tspan's own* (scaled) font-size. Each emitted `dy` is
 * therefore the root-em delta divided by the tspan's font scale, so a shift of
 * `d` root-em applied on a `s`-scaled run renders as exactly `d` — nested and
 * consecutive scripts return to the parent baseline with zero drift.
 *
 * @param value - Raw micro-math label.
 * @returns Trusted compiler-owned XML text suitable inside an SVG `<text>` node.
 */
export function renderMathLabelTspans(value: string): string {
	const segments = parseMathLabel(value);
	if (segments.length === 1 && segments[0]?.kind === 'text' && segments[0].value === value) {
		return escapeXml(value);
	}
	/*
	 * One delta-based pass for every label. Each run carries its own `dy`
	 * measured from the previous run's baseline; the reset after a script is
	 * folded into the next real glyph rather than a standalone empty `<tspan>`,
	 * because SVG renderers ignore `dy` on empty tspans. Only a label that ends
	 * mid-script emits a trailing (harmless, terminal) restoring run.
	 */
	let previousShift = 0;
	let markup = '';
	for (const segment of segments) {
		const shift =
			segment.baselineShiftEm ??
			(segment.kind === 'subscript' ? 0.35 : segment.kind === 'superscript' ? -0.55 : 0);
		const scale = segment.fontScale ?? (segment.kind === 'text' ? 1 : 0.7);
		const delta = Number(((shift - previousShift) / scale).toFixed(4));
		const fontPercent = Number((scale * 100).toFixed(2));
		markup += `<tspan dy="${delta}em" font-size="${fontPercent}%">${escapeXml(segment.value)}</tspan>`;
		previousShift = shift;
	}
	if (previousShift !== 0) {
		markup += `<tspan dy="${Number((-previousShift).toFixed(4))}em" font-size="100%"></tspan>`;
	}
	return markup;
}
