/**
 * Exact integer geometry.
 *
 * Every coordinate the compiler reasons about is an integer count of
 * thousandths of a diagram unit ("milli-units"). Integers make the questions
 * the router and validator ask — do these spans touch, are these points the same,
 * is this segment collinear with that one — exact comparisons rather than
 * epsilon tests, and they make the decimal text the SVG carries a pure function
 * of the integer rather than of float noise: there is no `-0.000`, and no tie
 * decided by a value's binary representation.
 *
 * Arithmetic stays in ordinary doubles, which are exact for integers up to
 * 2^53. Sums and differences of coordinates never come near that; the one
 * product the compiler needs — the orientation of three points, for diagonal
 * wires — is guarded by {@link orientation}.
 *
 * Constructions that are not integral by nature (an even split of an odd span, a
 * text width) are rounded once, where they are made, by {@link roundDiv}.
 *
 * @module
 */

/** Milli-units per diagram unit. */
export const UNIT = 1000;

/** A point in milli-units. */
export interface IPoint {
	readonly x: number;
	readonly y: number;
}

/** An axis-aligned rectangle in milli-units, inclusive of its edges. */
export interface IRect {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

/**
 * Round `numerator / denominator` to the nearest integer, ties away from zero.
 *
 * `Math.round` sends ties towards +∞, so `-2.5` becomes `-2` while `2.5` becomes
 * `3`: a component mirrored through the origin would land half a milli-unit off
 * its reflection. Rounding symmetrically keeps a rotated drawing the exact
 * mirror of the unrotated one.
 *
 * @param numerator - Any finite number.
 * @param denominator - A positive divisor.
 */
export function roundDiv(numerator: number, denominator: number): number {
	const quotient = Math.abs(numerator) / denominator;
	const rounded = Math.floor(quotient + 0.5);
	return numerator < 0 ? -rounded : rounded;
}

/** Convert diagram units to milli-units, rounding once. */
export function toMilli(value: number): number {
	return roundDiv(value * UNIT, 1);
}

/** Convert milli-units back to diagram units for the public, unit-based API. */
export function fromMilli(value: number): number {
	return value / UNIT;
}

/**
 * Format milli-units as the shortest exact decimal of diagram units.
 *
 * `1500` is `1.5`, `-250` is `-0.25`, `0` is `0`. The text is built from the
 * integer's digits, so it cannot depend on how an engine prints a double.
 */
export function fmt(value: number): string {
	const magnitude = value < 0 ? -value : value;
	const whole = Math.floor(magnitude / UNIT);
	let text = String(whole);
	const fraction = magnitude - whole * UNIT;
	if (fraction !== 0) {
		let digits = String(fraction + UNIT).slice(1);
		while (digits.endsWith('0')) digits = digits.slice(0, -1);
		text += `.${digits}`;
	}
	return value < 0 ? `-${text}` : text;
}

/** Clockwise quarter turns: 0 right, 1 down, 2 left, 3 up. */
export type Turn = 0 | 1 | 2 | 3;

/** Rotate a local point clockwise by `turn` quarter turns, exactly. */
export function rotate(point: IPoint, turn: Turn): IPoint {
	switch (turn) {
		case 0:
			return { x: point.x + 0, y: point.y + 0 };
		case 1:
			return { x: 0 - point.y, y: point.x + 0 };
		case 2:
			return { x: 0 - point.x, y: 0 - point.y };
		case 3:
			return { x: point.y + 0, y: 0 - point.x };
	}
}

/** Whether two rectangles share interior area (touching edges do not). */
export function overlaps(left: IRect, right: IRect): boolean {
	return left.minX < right.maxX && left.maxX > right.minX && left.minY < right.maxY && left.maxY > right.minY;
}

/** Whether `outer` contains `inner`, edges included. */
export function contains(outer: IRect, inner: IRect): boolean {
	return outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
}

/** Grow a rectangle by `margin` on every side. */
export function inflate(rect: IRect, margin: number): IRect {
	return { minX: rect.minX - margin, minY: rect.minY - margin, maxX: rect.maxX + margin, maxY: rect.maxY + margin };
}

/** Whether an axis-aligned segment passes through a rectangle's interior. */
export function axisSegmentEntersRect(a: IPoint, b: IPoint, rect: IRect): boolean {
	if (a.y === b.y) {
		return a.y > rect.minY && a.y < rect.maxY && Math.max(a.x, b.x) > rect.minX && Math.min(a.x, b.x) < rect.maxX;
	}
	return a.x > rect.minX && a.x < rect.maxX && Math.max(a.y, b.y) > rect.minY && Math.min(a.y, b.y) < rect.maxY;
}

/**
 * Sign of the orientation of `c` relative to the directed line `a → b`.
 *
 * Returns 1 for counter-clockwise (in a y-down frame, clockwise on screen),
 * -1 for the other side, and 0 when collinear. The two products are exact
 * whenever every coordinate difference is below 2^26 milli-units (about 67,000
 * diagram units); beyond that they are compared through BigInt, so the answer is
 * exact on any canvas the compiler accepts.
 */
export function orientation(a: IPoint, b: IPoint, c: IPoint): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const acx = c.x - a.x;
	const acy = c.y - a.y;
	const limit = 67_108_864;
	if (Math.abs(abx) < limit && Math.abs(aby) < limit && Math.abs(acx) < limit && Math.abs(acy) < limit) {
		const value = abx * acy - aby * acx;
		return value > 0 ? 1 : value < 0 ? -1 : 0;
	}
	const value = BigInt(abx) * BigInt(acy) - BigInt(aby) * BigInt(acx);
	return value > 0n ? 1 : value < 0n ? -1 : 0;
}

/** Whether `p`, known to be collinear with `a`–`b`, lies within that closed segment. */
function onSegment(a: IPoint, b: IPoint, p: IPoint): boolean {
	return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

/**
 * Classify how two closed segments meet, exactly.
 *
 * - `undefined`: they do not touch.
 * - `'cross'`: they cross at a single point interior to both.
 * - `'touch'`: they meet at an endpoint of either, or overlap collinearly.
 */
export function segmentContact(a: IPoint, b: IPoint, c: IPoint, d: IPoint): 'cross' | 'touch' | undefined {
	const o1 = orientation(a, b, c);
	const o2 = orientation(a, b, d);
	const o3 = orientation(c, d, a);
	const o4 = orientation(c, d, b);
	if (o1 !== o2 && o3 !== o4) {
		return o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0 ? 'touch' : 'cross';
	}
	if (
		(o1 === 0 && onSegment(a, b, c)) ||
		(o2 === 0 && onSegment(a, b, d)) ||
		(o3 === 0 && onSegment(c, d, a)) ||
		(o4 === 0 && onSegment(c, d, b))
	) {
		return 'touch';
	}
	return undefined;
}

/**
 * Parse a DSL decimal straight to milli-units without passing through a double.
 *
 * `389.425` becomes `389425` exactly. Digits past the third decimal round half
 * away from zero, the same rule {@link roundDiv} uses everywhere else.
 */
export function parseMilli(text: string): number {
	const negative = text.startsWith('-');
	const body = negative || text.startsWith('+') ? text.slice(1) : text;
	const point = body.indexOf('.');
	const whole = point < 0 ? body : body.slice(0, point);
	const fraction = point < 0 ? '' : body.slice(point + 1);
	let value = Number(whole || '0') * UNIT + Number((fraction + '000').slice(0, 3));
	if (fraction.length > 3 && fraction.charCodeAt(3) >= 53) value += 1;
	return negative && value !== 0 ? -value : value;
}
