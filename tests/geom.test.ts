/**
 * Integer geometry: the exact primitives every drawing is built from.
 *
 * Everything downstream assumes these never round twice and never depend on
 * how an engine prints or multiplies a double, so each is pinned at its edges.
 */
import { describe, expect, test } from 'vitest';

import {
	axisSegmentEntersRect,
	contains,
	fmt,
	fromMilli,
	inflate,
	orientation,
	overlaps,
	parseMilli,
	rotate,
	roundDiv,
	segmentContact,
	toMilli
} from '../src/geom.js';

describe('rounding and formatting', () => {
	test('rounds ties away from zero on both sides of the origin', () => {
		expect([roundDiv(5, 2), roundDiv(-5, 2), roundDiv(4, 3), roundDiv(-4, 3), roundDiv(0, 7)]).toEqual([3, -3, 1, -1, 0]);
		expect(toMilli(0.0005)).toBe(1);
		expect(toMilli(-0.0005)).toBe(-1);
		expect(fromMilli(1500)).toBe(1.5);
	});

	test('formats the shortest exact decimal from the integer digits', () => {
		expect([fmt(0), fmt(1500), fmt(-250), fmt(7), fmt(-1), fmt(120_000), fmt(190_667)]).toEqual([
			'0',
			'1.5',
			'-0.25',
			'0.007',
			'-0.001',
			'120',
			'190.667'
		]);
	});

	test('parses DSL decimals straight to milli-units', () => {
		expect(parseMilli('389.425')).toBe(389_425);
		expect(parseMilli('+2')).toBe(2000);
		expect(parseMilli('.5')).toBe(500);
		expect(parseMilli('-.5')).toBe(-500);
		expect(parseMilli('1.2345')).toBe(1235);
		expect(parseMilli('1.2344')).toBe(1234);
		expect(parseMilli('-1.0005')).toBe(-1001);
		/* A negative value that rounds to nothing is zero, never negative zero. */
		expect(Object.is(parseMilli('-0.0004'), 0)).toBe(true);
	});
});

describe('transforms and rectangles', () => {
	test('rotates exactly by every quarter turn, never producing negative zero', () => {
		const point = { x: 3, y: 0 };
		expect([0, 1, 2, 3].map((turn) => rotate(point, turn as 0 | 1 | 2 | 3))).toEqual([
			{ x: 3, y: 0 },
			{ x: 0, y: 3 },
			{ x: -3, y: 0 },
			{ x: 0, y: -3 }
		]);
		for (const turn of [0, 1, 2, 3] as const) {
			const { x, y } = rotate({ x: 0, y: 0 }, turn);
			expect(Object.is(x, -0) || Object.is(y, -0)).toBe(false);
		}
	});

	test('treats touching edges as neither overlap nor entry', () => {
		const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
		expect(overlaps(rect, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
		expect(overlaps(rect, { minX: 9, minY: 9, maxX: 20, maxY: 20 })).toBe(true);
		expect(contains(rect, rect)).toBe(true);
		expect(contains(rect, inflate(rect, 1))).toBe(false);
		expect(inflate(rect, 2)).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
		expect(axisSegmentEntersRect({ x: -5, y: 10 }, { x: 15, y: 10 }, rect)).toBe(false);
		expect(axisSegmentEntersRect({ x: -5, y: 5 }, { x: 15, y: 5 }, rect)).toBe(true);
		expect(axisSegmentEntersRect({ x: 5, y: -5 }, { x: 5, y: 0 }, rect)).toBe(false);
		expect(axisSegmentEntersRect({ x: 5, y: 20 }, { x: 5, y: 1 }, rect)).toBe(true);
	});
});

describe('exact predicates', () => {
	test('orients points exactly, through BigInt past 2^26', () => {
		expect(orientation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 })).toBe(1);
		expect(orientation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 })).toBe(-1);
		expect(orientation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 })).toBe(0);
		/* Differences this large overflow a double's exact products. */
		const big = 2 ** 40;
		expect(orientation({ x: 0, y: 0 }, { x: big, y: big + 1 }, { x: big - 1, y: big })).toBe(1);
		expect(orientation({ x: 0, y: 0 }, { x: big, y: big + 1 }, { x: big + 1, y: big + 2 })).toBe(-1);
		expect(orientation({ x: 0, y: 0 }, { x: big, y: big }, { x: 2 * big, y: 2 * big })).toBe(0);
	});

	test('classifies crossings, touches, collinear overlap and misses', () => {
		const o = { x: 0, y: 0 };
		expect(segmentContact({ x: -5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: -5 }, { x: 0, y: 5 })).toBe('cross');
		expect(segmentContact({ x: -5, y: 0 }, { x: 5, y: 0 }, o, { x: 0, y: 5 })).toBe('touch');
		expect(segmentContact({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 })).toBe('touch');
		expect(segmentContact({ x: 5, y: 0 }, { x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe('touch');
		expect(segmentContact({ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toBe('touch');
		expect(segmentContact({ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe('touch');
		expect(segmentContact({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 11, y: 0 }, { x: 20, y: 0 })).toBeUndefined();
		expect(segmentContact({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 })).toBeUndefined();
	});
});
