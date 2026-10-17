/**
 * How the layout reports what the router did, with the router stubbed.
 *
 * Reaching a state-budget failure or a negotiated rip-up through real geometry
 * takes either millions of search states or a hand-built corridor; both are
 * covered against the router itself in route.test.ts. Here the router's answer
 * is fixed so the layout's translation of it can be checked exactly.
 */
import { describe, expect, test, vi } from 'vitest';

import type { RouterInput, RouterResult } from '../src/route.js';

let answer: (input: RouterInput) => RouterResult;
vi.mock('../src/route.js', async (original) => ({
	...(await original<typeof import('../src/route.js')>()),
	routeWires: (input: RouterInput) => answer(input)
}));

const { compileSchematic } = await import('../src/index.js');

const fence = { bounds: { width: 600, height: 400 }, title: 'report' } as const;
const source = 'port:A "A" at (60,100) #blue\nport:B "B" at (400,100) #blue [orientation=left]\nport:C "C" at (60,300) #blue\nport:D "D" at (400,300) #blue [orientation=left]\nA.out -> B.in #blue [ortho]\nC.out -> D.in #blue [ortho]';

describe('router report', () => {
	test('names the state budget when a search runs out of it', () => {
		answer = () => ({ wires: [], attempts: 0, rippedUp: [], failed: 1, reason: 'complexity' });
		expect(() => compileSchematic(source, fence)).toThrow('Line 6: Orthogonal routing complexity exceeds 2,000,000 search states.');
	});

	test('maps rip-ups back to connection indices', () => {
		answer = (input) => ({
			wires: input.wires.map((wire) => ({ points: [wire.from.point, wire.from.escape, { x: wire.from.escape.x, y: wire.to.escape.y }, wire.to.escape, wire.to.point] })),
			attempts: 2,
			rippedUp: [
				{ wire: 1, attempt: 1 },
				{ wire: 0, attempt: 2 }
			]
		});
		const result = compileSchematic(source, fence);
		expect(result.routing.attempts).toBe(2);
		expect(result.routing.rippedUp).toEqual([
			{ connectionIndex: 1, attempt: 1 },
			{ connectionIndex: 0, attempt: 2 }
		]);
	});
});
