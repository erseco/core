/**
 * The net router on its own: lattice search, trees, negotiation and budgets.
 *
 * Everything here is in milli-units, the router's native frame. Walls are
 * `expanded` obstacles owned by no terminal, so they block every wire.
 */
import { describe, expect, test } from 'vitest';

import { compact, routeWires, type RouterInput, type RouterTerminal, type RouterWire } from '../src/route.js';
import { parsedSchematicEvidence } from '../src/route-cache.js';

const U = 1000;
const point = (x: number, y: number) => ({ x: x * U, y: y * U });
const wall = (owner: number, minX: number, minY: number, maxX: number, maxY: number) =>
	({ owner, kind: 'expanded', rect: { minX: minX * U, minY: minY * U, maxX: maxX * U, maxY: maxY * U } }) as const;
const pin = (owner: number, x: number, y: number, ex = x, ey = y): RouterTerminal => ({
	owner,
	point: point(x, y),
	escape: point(ex, ey)
});
const wire = (from: RouterTerminal, to: RouterTerminal, net: number, extra: Partial<RouterWire> = {}): RouterWire => ({
	from,
	to,
	net,
	group: -1,
	joinFrom: false,
	joinTo: false,
	...extra
});
const units = (points: readonly { x: number; y: number }[]) => points.map((p) => [p.x / U, p.y / U]);

/*
 * Two corridors, each a single track along the shared edge of two walls:
 * row 100 and row 200, both spanning x 100..300. A one-track pocket at column
 * 200 opens downward onto row 100. Walls run past the canvas so nothing slips
 * round them.
 */
const corridors = [
	wall(900, 100, -50, 200, 100),
	wall(901, 200, -50, 300, 100),
	wall(902, 100, 100, 300, 200),
	wall(903, 100, 200, 300, 350)
];
const bounds = { width: 400 * U, height: 300 * U };

describe('negotiation', () => {
	test('moves the net that has another way round off the track the other one needs', () => {
		/* A routes first and takes row 100. B lives in the pocket: every path it
		   has leaves through (200, 100), on A's wire. Negotiation must send A
		   through row 200 instead. */
		const input: RouterInput = {
			bounds,
			obstacles: corridors,
			/* A's pins face each other: in pass one it takes the straight shortcut,
			   which negotiation must then refuse it. */
			wires: [wire(pin(1, 40, 100, 52, 100), pin(2, 360, 100, 348, 100), 1), wire(pin(3, 200, 10), pin(4, 360, 40), 2)],
			fixed: [],
			attempts: 4
		};
		const result = routeWires(input);
		expect(result.failed).toBeUndefined();
		expect(result.attempts).toBeGreaterThan(0);
		expect(result.rippedUp.map((entry) => entry.wire).sort()).toEqual([0, 1]);
		const [a, b] = result.wires.map((route) => units(route.points));
		expect(a!.some(([, y]) => y === 200)).toBe(true);
		expect(b).toContainEqual([200, 100]);
		/* And the same input routes identically again. */
		expect(routeWires(input)).toEqual(result);
	});

	test('negotiates two separate disputes, each with its own history', () => {
		/* The same dispute twice, 400 units apart: each rerouted net's window
		   holds only its own contested points. */
		const shift = (dx: number) => corridors.map((entry) => wall(entry.owner + dx, entry.rect.minX / U + dx, entry.rect.minY / U, entry.rect.maxX / U + dx, entry.rect.maxY / U));
		const pair = (dx: number, net: number): RouterWire[] => [
			wire(pin(net, 40 + dx, 100), pin(net + 1, 360 + dx, 112), net),
			wire(pin(net + 2, 200 + dx, 10), pin(net + 3, 360 + dx, 40), net + 1)
		];
		const result = routeWires({
			bounds: { width: 800 * U, height: 300 * U },
			obstacles: [...corridors, ...shift(400)],
			wires: [...pair(0, 1), ...pair(400, 10)],
			fixed: [],
			attempts: 4
		});
		expect(result.failed).toBeUndefined();
		expect(new Set(result.rippedUp.map((entry) => entry.wire))).toEqual(new Set([0, 1, 2, 3]));
	});

	test('reports contention when both nets need the only track', () => {
		const input: RouterInput = {
			bounds,
			obstacles: [wall(900, 100, -50, 300, 100), wall(902, 100, 100, 300, 350)],
			wires: [wire(pin(1, 40, 100), pin(2, 360, 112), 1), wire(pin(3, 40, 60), pin(4, 360, 140), 2)],
			fixed: [],
			attempts: 3
		};
		const result = routeWires(input);
		expect(result.reason).toBe('contention');
		expect(result.attempts).toBe(3);
		expect(result.wires).toEqual([]);
		/* With one attempt contact is never allowed, so the net routed second fails
		   at once. Order is geometric: the second wire's pin sits higher, so it
		   goes first whatever the declaration order. */
		expect(routeWires({ ...input, attempts: 1 })).toMatchObject({ reason: 'contention', attempts: 0, failed: 0 });
		expect(routeWires({ ...input, wires: [...input.wires].reverse(), attempts: 1 })).toMatchObject({ failed: 1 });
	});

	test('counts a drawn wire of another net as contact it cannot move', () => {
		const input: RouterInput = {
			bounds,
			obstacles: [wall(900, 100, -50, 300, 100), wall(902, 100, 100, 300, 350)],
			wires: [wire(pin(1, 40, 100), pin(2, 360, 112), 1)],
			fixed: [{ net: 2, a: point(150, 100), b: point(250, 100) }],
			attempts: 3
		};
		expect(routeWires(input)).toMatchObject({ reason: 'contention', failed: 0 });
	});
});

describe('search', () => {
	test('takes a slightly longer path to avoid a bridge it does not need', () => {
		/* A wall splits B's straight path. Over the top is 20 units shorter but
		   crosses A; underneath is clear. A crossing costs more than 20 units. */
		const result = routeWires({
			bounds,
			obstacles: [wall(900, 190, 50, 210, 160)],
			wires: [wire(pin(1, 60, 20), pin(2, 250, 80), 1), wire(pin(3, 100, 100), pin(4, 300, 100), 2)],
			fixed: [],
			attempts: 1
		});
		expect(result.failed).toBeUndefined();
		expect(units(result.wires[1]!.points)).toEqual([
			[100, 100],
			[100, 160],
			[300, 160],
			[300, 100]
		]);
	});

	test('a routed label blocks the facing shortcut of a later wire', () => {
		/* The labeled wire routes first (its pin is leftmost); its label sits
		   between the facing pins of the second, which must go round it. */
		const label = { minX: 180 * U, minY: 90 * U, maxX: 220 * U, maxY: 110 * U };
		const result = routeWires({
			bounds,
			obstacles: [],
			wires: [
				wire(pin(1, 20, 250), pin(2, 380, 250), 1, { label: () => label }),
				wire(pin(3, 100, 100, 112, 100), pin(4, 300, 100, 288, 100), 2),
				/* A label beside the line, not on it, leaves the shortcut alone. */
				wire(pin(5, 100, 160, 112, 160), pin(6, 300, 160, 288, 160), 3)
			],
			fixed: [],
			attempts: 1
		});
		expect(result.failed).toBeUndefined();
		expect(result.wires[1]!.points.length).toBeGreaterThan(2);
		expect(units(result.wires[2]!.points)).toEqual([
			[100, 160],
			[300, 160]
		]);
	});

	test('pins that coincide route through the lattice, not the shortcut', () => {
		const result = routeWires({
			bounds,
			obstacles: [],
			wires: [wire(pin(1, 50, 50, 38, 50), pin(2, 50, 50, 62, 50), 1)],
			fixed: [],
			attempts: 1
		});
		expect(units(result.wires[0]!.points)).toEqual([
			[50, 50],
			[50, 50]
		]);
	});

	test('a tree never meets four ways at one point', () => {
		/* Four pins around a plus: the natural tree is a cross at (200, 100). */
		const group = { group: 0, joinFrom: true, joinTo: true };
		const center = pin(1, 40, 100, 52, 100);
		const result = routeWires({
			bounds,
			obstacles: [],
			wires: [
				wire(center, pin(2, 360, 100, 348, 100), 1, group),
				wire(center, pin(3, 200, 20, 200, 32), 1, group),
				wire(center, pin(4, 200, 180, 200, 168), 1, group)
			],
			fixed: [],
			attempts: 1
		});
		expect(result.failed).toBeUndefined();
		const degree = new Map<string, number>();
		for (const route of result.wires) {
			for (let step = 1; step < route.points.length; step += 1) {
				for (const end of [route.points[step - 1]!, route.points[step]!]) {
					const key = `${end.x},${end.y}`;
					degree.set(key, (degree.get(key) ?? 0) + 1);
				}
			}
		}
		expect(Math.max(...degree.values())).toBeLessThan(4);
	});

	test('a branch does not run into the vertical stub of a pin not yet joined', () => {
		/* The pin at (200, 40) faces down; its stub reaches (200, 52). The first
		   branch goes to the far pin and must not touch that stub on the way. */
		const group = { group: 0, joinFrom: true, joinTo: true };
		const root = pin(1, 40, 100, 52, 100);
		const result = routeWires({
			bounds,
			obstacles: [],
			wires: [
				wire(root, pin(2, 360, 60, 348, 60), 1, group),
				wire(root, pin(3, 380, 20, 368, 20), 1, group),
				wire(root, pin(4, 200, 40, 200, 52), 1, group)
			],
			fixed: [],
			attempts: 1
		});
		expect(result.failed).toBeUndefined();
	});
});

describe('budgets and failures', () => {
	test('reports a search that exhausts its state budget', () => {
		const input: RouterInput = {
			bounds,
			obstacles: [],
			wires: [wire(pin(1, 10, 10), pin(2, 390, 290), 1)],
			fixed: [],
			attempts: 1,
			states: 5
		};
		expect(routeWires(input)).toMatchObject({ reason: 'complexity', failed: 0 });
	});

	test('reports a terminal walled in on every side as unroutable', () => {
		const input: RouterInput = {
			bounds,
			obstacles: [wall(900, 180, 80, 220, 90), wall(901, 180, 110, 220, 120), wall(902, 180, 80, 190, 120), wall(903, 210, 80, 220, 120)],
			wires: [wire(pin(1, 40, 100), pin(2, 200, 100), 1)],
			fixed: [],
			attempts: 4
		};
		expect(routeWires(input)).toMatchObject({ reason: 'unroutable', failed: 0 });
	});
});

describe('compact', () => {
	test('drops repeated points and collinear corners', () => {
		expect(units(compact([point(0, 0), point(0, 0), point(5, 0), point(10, 0), point(10, 5), point(10, 9)]))).toEqual([
			[0, 0],
			[10, 0],
			[10, 9]
		]);
	});
});

describe('parse evidence', () => {
	test('a document assembled by hand reads as having no placements and no routing', () => {
		expect(parsedSchematicEvidence({ components: [], connections: [] })).toEqual({
			placements: [],
			routing: { attempts: 0, rippedUp: [], congestion: [], nudged: false }
		});
	});
});
