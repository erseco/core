/**
 * Net-based orthogonal router.
 *
 * ## What it routes
 *
 * The unit of routing is the *net*, not the two-pin connection. Connections that
 * share terminals form a group, and a group is grown as one tree: its first
 * connection runs terminal to terminal, and every later one leaves the nearest
 * copper the group already has, at a junction, rather than running back to its
 * own pin. A connection whose joining end carries a marker keeps its full
 * terminal-to-terminal path, so an arrowhead never lands on a junction.
 *
 * ## Where it routes
 *
 * Wires live on a lattice: every multiple of one channel pitch, plus the
 * coordinates that matter — obstacle edges, pins, and the escape points just
 * outside each body. Lattice lines within half a pitch of one of those are
 * dropped, so any two wires on different lines are at least half a pitch apart
 * and wires on lattice lines a full pitch apart. The lattice is never built for
 * the whole canvas: each search materialises only its own window.
 *
 * ## How it resolves contention
 *
 * Every group is routed once in a canonical order derived from geometry — never
 * from declaration order — with contact against other nets forbidden. Most
 * documents finish there. A group that cannot be placed that way is routed with
 * contact allowed at a price, and the router then negotiates: groups involved in
 * a contact are torn up and rerouted with the price raised and a history cost
 * added at every location that has been contested before (PathFinder,
 * McMurchie & Ebeling 1995). Every cost is an integer, so the result is exact
 * and identical on every engine.
 *
 * @module
 */
import { axisSegmentEntersRect, segmentContact, type IPoint, type IRect } from './geom.js';

/** Channel pitch: the spacing of lattice lines, in milli-units. */
export const PITCH = 12_000;
/** Cost of one bend, in milli-units of equivalent wire. */
const BEND = 100_000;
/** Cost of one crossing, used only by the bounded second search. */
const CROSS = 48_000;
/** Price of contact with another net in the first negotiated iteration. */
const CONTACT = 2_000_000;
/** History added at a contested location per iteration. */
const HISTORY = 1_000_000;
/** Lattice margin around a search's bounding box. */
const WINDOW_MARGIN = 8 * PITCH;
/** Search-state ceiling for one connection. */
export const MAX_ROUTER_STATES = 2_000_000;

/** An obstacle: `body` blocks the component's own wires; `expanded` and `label` block everyone else's. */
export interface RouterObstacle {
	readonly owner: number;
	readonly kind: 'body' | 'expanded' | 'label';
	readonly rect: IRect;
}

/** One pin: where it is, and the point just outside its body where routing begins. */
export interface RouterTerminal {
	readonly owner: number;
	readonly point: IPoint;
	readonly escape: IPoint;
}

/** One orthogonal connection to route. */
export interface RouterWire {
	readonly from: RouterTerminal;
	readonly to: RouterTerminal;
	/** Contact identity: wires with equal `net` may touch. */
	readonly net: number;
	/** Tree group; wires sharing a group grow one tree. `-1` routes alone. */
	readonly group: number;
	/** Whether the `from` end may be replaced by a junction on the group's copper. */
	readonly joinFrom: boolean;
	/** Whether the `to` end may be replaced by a junction on the group's copper. */
	readonly joinTo: boolean;
	/** Label occupancy once routed, added as an obstacle for later wires. */
	readonly label?: ((points: readonly IPoint[]) => IRect | undefined) | undefined;
}

/** A straight or curved wire already fixed in place, which orthogonal wires of other nets must not touch. */
export interface RouterFixed {
	readonly net: number;
	readonly a: IPoint;
	readonly b: IPoint;
}

export interface RouterInput {
	readonly bounds?: { readonly width: number; readonly height: number } | undefined;
	readonly obstacles: readonly RouterObstacle[];
	readonly wires: readonly RouterWire[];
	readonly fixed: readonly RouterFixed[];
	/** Iteration budget; `1` forbids contact outright and never negotiates. */
	readonly attempts: number;
}

export interface RoutedWire {
	readonly points: readonly IPoint[];
	/** Where a branch leaves its group's copper, when that is its first point. */
	readonly junction?: IPoint;
}

export interface RouterResult {
	readonly wires: readonly RoutedWire[];
	readonly attempts: number;
	readonly rippedUp: readonly { readonly wire: number; readonly attempt: number }[];
	/** The wire that could not be placed, when routing failed. */
	readonly failed?: number;
	/** Why it failed: no path at all, or contact that negotiation could not remove. */
	readonly reason?: 'unroutable' | 'contention' | 'complexity';
}

/** Axis-aligned copper owned by one routing unit. */
interface Copper {
	readonly a: IPoint;
	readonly b: IPoint;
	readonly net: number;
	readonly unit: number;
	readonly stub: boolean;
}

/** A group grown as one tree, or one wire routed alone. */
interface Unit {
	readonly index: number;
	readonly net: number;
	readonly wires: readonly number[];
	readonly tree: boolean;
	readonly key: readonly [number, number, number, number];
}

const pointKey = (point: IPoint): string => `${point.x},${point.y}`;

/** Lexicographic comparison of two points, x first. */
function comparePoints(left: IPoint, right: IPoint): number {
	return left.x - right.x || left.y - right.y;
}

/** First index in sorted `values` whose value is at least `target`. */
function lowerBound(values: ArrayLike<number>, target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (values[middle]! < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Sorted, de-duplicated copy. */
function uniqueSorted(values: number[]): Float64Array {
	values.sort((left, right) => left - right);
	const out: number[] = [];
	for (const value of values) if (out.length === 0 || out[out.length - 1] !== value) out.push(value);
	return Float64Array.from(out);
}

/** Lattice coordinates on one axis within [low, high]: pitch multiples away from the specials, plus the specials. */
function axisCoordinates(specials: Float64Array, low: number, high: number): Float64Array {
	const values: number[] = [];
	const first = lowerBound(specials, low);
	for (let index = first; index < specials.length && specials[index]! <= high; index += 1) values.push(specials[index]!);
	const half = PITCH / 2;
	for (let value = Math.ceil(low / PITCH) * PITCH; value <= high; value += PITCH) {
		const near = lowerBound(specials, value - half + 1);
		if (near < specials.length && specials[near]! < value + half) continue;
		values.push(value);
	}
	return uniqueSorted(values);
}

/* Node flags for one search window. */
const OTHER_H = 1;
const OTHER_V = 2;
const OTHER_END = 4;
const OWN = 8;
const OWN_JUNCTION = 16;
const AVOID = 32;

/** Reusable search scratch, grown to the largest window and never shrunk. */
class Scratch {
	node = new Uint8Array(0);
	blockH = new Uint8Array(0);
	blockV = new Uint8Array(0);
	occH = new Uint8Array(0);
	occV = new Uint8Array(0);
	history = new Float64Array(0);
	g = new Float64Array(0);
	crossings = new Int32Array(0);
	previous = new Int32Array(0);
	stamp = new Int32Array(0);
	epoch = 0;
	heapState = new Int32Array(0);
	heapF = new Float64Array(0);
	heapG = new Float64Array(0);
	size = 0;

	begin(cells: number): void {
		if (cells > this.node.length) {
			this.node = new Uint8Array(cells);
			this.blockH = new Uint8Array(cells);
			this.blockV = new Uint8Array(cells);
			this.occH = new Uint8Array(cells);
			this.occV = new Uint8Array(cells);
			this.history = new Float64Array(cells);
			this.g = new Float64Array(cells * 3);
			this.crossings = new Int32Array(cells * 3);
			this.previous = new Int32Array(cells * 3);
			this.stamp = new Int32Array(cells * 3);
			this.epoch = 0;
		} else {
			this.node.fill(0, 0, cells);
			this.blockH.fill(0, 0, cells);
			this.blockV.fill(0, 0, cells);
			this.occH.fill(0, 0, cells);
			this.occV.fill(0, 0, cells);
			this.history.fill(0, 0, cells);
		}
		this.epoch += 1;
		this.size = 0;
	}

	/**
	 * Heap order: cheapest estimate first, then the deeper of two equal estimates,
	 * then the lower state index. A total order, so the pop sequence — and the
	 * path — is a function of the costs alone, whatever the insertion order.
	 * Preferring depth on ties lets the search run down a plateau of equal-cost
	 * lattice paths instead of widening across all of them.
	 */
	private before(f1: number, g1: number, s1: number, f2: number, g2: number, s2: number): boolean {
		return f1 !== f2 ? f1 < f2 : g1 !== g2 ? g1 > g2 : s1 < s2;
	}

	push(state: number, g: number, f: number): void {
		if (this.size === this.heapState.length) {
			const capacity = Math.max(64, this.size * 2);
			const states = new Int32Array(capacity);
			const fs = new Float64Array(capacity);
			const gs = new Float64Array(capacity);
			states.set(this.heapState);
			fs.set(this.heapF);
			gs.set(this.heapG);
			this.heapState = states;
			this.heapF = fs;
			this.heapG = gs;
		}
		let index = this.size++;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (!this.before(f, g, state, this.heapF[parent]!, this.heapG[parent]!, this.heapState[parent]!)) break;
			this.heapState[index] = this.heapState[parent]!;
			this.heapF[index] = this.heapF[parent]!;
			this.heapG[index] = this.heapG[parent]!;
			index = parent;
		}
		this.heapState[index] = state;
		this.heapF[index] = f;
		this.heapG[index] = g;
	}

	/** Remove the cheapest entry, returning its state; its cost is left in `g`. */
	pop(): number {
		const top = this.heapState[0]!;
		const size = --this.size;
		if (size > 0) {
			const state = this.heapState[size]!;
			const f = this.heapF[size]!;
			const g = this.heapG[size]!;
			let index = 0;
			for (;;) {
				const left = index * 2 + 1;
				if (left >= size) break;
				const right = left + 1;
				const child =
					right < size &&
					this.before(this.heapF[right]!, this.heapG[right]!, this.heapState[right]!, this.heapF[left]!, this.heapG[left]!, this.heapState[left]!)
						? right
						: left;
				if (!this.before(this.heapF[child]!, this.heapG[child]!, this.heapState[child]!, f, g, state)) break;
				this.heapState[index] = this.heapState[child]!;
				this.heapF[index] = this.heapF[child]!;
				this.heapG[index] = this.heapG[child]!;
				index = child;
			}
			this.heapState[index] = state;
			this.heapF[index] = f;
			this.heapG[index] = g;
		}
		return top;
	}

	known(state: number): number {
		return this.stamp[state] === this.epoch ? this.g[state]! : Number.POSITIVE_INFINITY;
	}

	/**
	 * Whether reaching `state` at cost `g` with `crossings` beats what is known.
	 * Crossings decide only between equally cheap arrivals: as a cost they would
	 * make the search exhaust every crossing-free state before accepting the
	 * crossings a bus cannot avoid.
	 */
	improves(state: number, g: number, crossings: number): boolean {
		if (this.stamp[state] !== this.epoch) return true;
		const known = this.g[state]!;
		return g < known || (g === known && crossings < this.crossings[state]!);
	}

	relax(state: number, from: number, g: number, crossings = 0): void {
		this.g[state] = g;
		this.crossings[state] = crossings;
		this.previous[state] = from;
		this.stamp[state] = this.epoch;
	}
}

const scratch = new Scratch();

/** Mutable router state for one call. */
class Router {
	readonly specialsX: Float64Array;
	readonly specialsY: Float64Array;
	readonly units: Unit[] = [];
	readonly unitOf: Int32Array;
	copper: Copper[] = [];
	readonly routes: (RoutedWire | undefined)[];
	readonly labels: (RouterObstacle | undefined)[];
	readonly history = new Map<string, number>();
	readonly canvas: IRect;
	/** Contact price for soft searches; `Infinity` while contact is forbidden. */
	contact = Number.POSITIVE_INFINITY;
	/** Whether the current search hit a contact it had to pay for. */
	touched = false;

	constructor(readonly input: RouterInput) {
		const xs: number[] = [];
		const ys: number[] = [];
		const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
		const note = (x: number, y: number): void => {
			xs.push(x);
			ys.push(y);
			extent.minX = Math.min(extent.minX, x);
			extent.minY = Math.min(extent.minY, y);
			extent.maxX = Math.max(extent.maxX, x);
			extent.maxY = Math.max(extent.maxY, y);
		};
		for (const obstacle of input.obstacles) {
			note(obstacle.rect.minX, obstacle.rect.minY);
			note(obstacle.rect.maxX, obstacle.rect.maxY);
		}
		for (const wire of input.wires) {
			for (const terminal of [wire.from, wire.to]) {
				note(terminal.point.x, terminal.point.y);
				note(terminal.escape.x, terminal.escape.y);
			}
		}
		if (input.bounds !== undefined) {
			note(0, 0);
			note(input.bounds.width, input.bounds.height);
			this.canvas = { minX: 0, minY: 0, maxX: input.bounds.width, maxY: input.bounds.height };
		} else {
			this.canvas = {
				minX: extent.minX - 4 * WINDOW_MARGIN,
				minY: extent.minY - 4 * WINDOW_MARGIN,
				maxX: extent.maxX + 4 * WINDOW_MARGIN,
				maxY: extent.maxY + 4 * WINDOW_MARGIN
			};
		}
		this.specialsX = uniqueSorted(xs);
		this.specialsY = uniqueSorted(ys);
		this.routes = new Array(input.wires.length).fill(undefined);
		this.labels = new Array(input.wires.length).fill(undefined);
		this.unitOf = new Int32Array(input.wires.length);
		this.buildUnits();
	}

	/** Partition wires into trees and lone wires, ordered by geometry alone. */
	private buildUnits(): void {
		const groups = new Map<number, number[]>();
		const singles: number[] = [];
		for (const [index, wire] of this.input.wires.entries()) {
			if (wire.group < 0) singles.push(index);
			else {
				const members = groups.get(wire.group);
				if (members === undefined) groups.set(wire.group, [index]);
				else members.push(index);
			}
		}
		const drafts: { net: number; wires: number[]; tree: boolean; key: [number, number, number, number] }[] = [];
		const keyOf = (wires: readonly number[]): [number, number, number, number] => {
			let best: IPoint | undefined;
			let second: IPoint | undefined;
			for (const index of wires) {
				const wire = this.input.wires[index]!;
				const [low, high] = comparePoints(wire.from.escape, wire.to.escape) <= 0 ? [wire.from.escape, wire.to.escape] : [wire.to.escape, wire.from.escape];
				if (best === undefined || comparePoints(low, best) < 0 || (comparePoints(low, best) === 0 && comparePoints(high, second!) < 0)) {
					best = low;
					second = high;
				}
			}
			return [best!.x, best!.y, second!.x, second!.y];
		};
		for (const members of groups.values()) {
			drafts.push({ net: this.input.wires[members[0]!]!.net, wires: members, tree: true, key: keyOf(members) });
		}
		for (const index of singles) {
			drafts.push({ net: this.input.wires[index]!.net, wires: [index], tree: false, key: keyOf([index]) });
		}
		drafts.sort(
			(left, right) =>
				left.key[0] - right.key[0] ||
				left.key[1] - right.key[1] ||
				left.key[2] - right.key[2] ||
				left.key[3] - right.key[3] ||
				left.wires[0]! - right.wires[0]!
		);
		for (const [index, draft] of drafts.entries()) {
			this.units.push({ index, net: draft.net, wires: draft.wires, tree: draft.tree, key: draft.key });
			for (const wire of draft.wires) this.unitOf[wire] = index;
		}
	}

	/** Reserve every terminal stub as copper of its unit before anything routes. */
	seedStubs(): void {
		const seen = new Set<string>();
		for (const unit of this.units) {
			for (const index of unit.wires) {
				const wire = this.input.wires[index]!;
				for (const terminal of [wire.from, wire.to]) {
					const key = `${unit.index}|${pointKey(terminal.point)}`;
					if (seen.has(key)) continue;
					seen.add(key);
					if (terminal.point.x === terminal.escape.x && terminal.point.y === terminal.escape.y) continue;
					this.copper.push({ a: terminal.point, b: terminal.escape, net: unit.net, unit: unit.index, stub: true });
				}
			}
		}
	}

	/** Tear up everything a unit routed, keeping its stubs. */
	ripUp(unit: Unit): void {
		this.copper = this.copper.filter((piece) => piece.stub || piece.unit !== unit.index);
		for (const index of unit.wires) {
			this.routes[index] = undefined;
			this.labels[index] = undefined;
		}
	}

	/**
	 * Two pins that face each other along one line, with nothing between them,
	 * are joined by a straight wire pin to pin. Their escape points may even have
	 * crossed — pins closer than two clearances — where the lattice has no path,
	 * yet the drawing is obvious.
	 */
	private facing(unit: Unit, wire: RouterWire): IPoint[] | undefined {
		const a = wire.from.point;
		const b = wire.to.point;
		if (a.x !== b.x && a.y !== b.y) return undefined;
		if (a.x === b.x && a.y === b.y) return undefined;
		const toward = (from: RouterTerminal, at: IPoint) =>
			Math.sign(from.escape.x - from.point.x) === Math.sign(at.x - from.point.x) && Math.sign(from.escape.y - from.point.y) === Math.sign(at.y - from.point.y);
		if (!toward(wire.from, b) || !toward(wire.to, a)) return undefined;
		for (const obstacle of this.input.obstacles) {
			if (obstacle.kind === 'body' ? true : obstacle.owner !== wire.from.owner && obstacle.owner !== wire.to.owner) {
				if (obstacle.kind === 'label' && (obstacle.owner === wire.from.owner || obstacle.owner === wire.to.owner)) continue;
				if (axisSegmentEntersRect(a, b, obstacle.rect)) return undefined;
			}
		}
		for (const label of this.labels) if (label !== undefined && axisSegmentEntersRect(a, b, label.rect)) return undefined;
		for (const piece of this.copper) {
			if (piece.net !== unit.net && segmentContact(a, b, piece.a, piece.b) !== undefined) return undefined;
		}
		for (const fixed of this.input.fixed) {
			if (fixed.net !== unit.net && segmentContact(a, b, fixed.a, fixed.b) !== undefined) return undefined;
		}
		return [a, b];
	}

	/**
	 * Route one unit. Returns the wire that could not be placed, or `-1`.
	 */
	routeUnit(unit: Unit): number {
		if (!unit.tree) {
			const index = unit.wires[0]!;
			const wire = this.input.wires[index]!;
			const path = this.facing(unit, wire) ?? this.search(unit, [wire.from.escape], wire.to.escape, [], index, 'point');
			if (path === undefined) return index;
			this.commit(index, path, false, false);
			return -1;
		}
		const wires = unit.wires.map((index) => this.input.wires[index]!);
		/* The root is the terminal with the smallest escape point; growth then always
		   takes the pending connection whose new terminal is smallest. Both are
		   geometric, so the tree never depends on the order lines were written. */
		let root: RouterTerminal | undefined;
		for (const wire of wires) {
			for (const terminal of [wire.from, wire.to]) {
				if (root === undefined || comparePoints(terminal.escape, root.escape) < 0) root = terminal;
			}
		}
		const connected = new Set<string>([pointKey(root!.point)]);
		const pending = new Set(unit.wires);
		const loops: number[] = [];
		while (pending.size > 0) {
			let chosen = -1;
			let anchor: RouterTerminal | undefined;
			let free: RouterTerminal | undefined;
			for (const index of pending) {
				const wire = this.input.wires[index]!;
				const fromIn = connected.has(pointKey(wire.from.point));
				const toIn = connected.has(pointKey(wire.to.point));
				if (fromIn && toIn) {
					loops.push(index);
					pending.delete(index);
					continue;
				}
				if (fromIn === toIn) continue;
				const candidateFree = fromIn ? wire.to : wire.from;
				const candidateAnchor = fromIn ? wire.from : wire.to;
				const order =
					free === undefined
						? -1
						: comparePoints(candidateFree.escape, free.escape) || comparePoints(candidateAnchor.escape, anchor!.escape) || index - chosen;
				if (order < 0) {
					chosen = index;
					free = candidateFree;
					anchor = candidateAnchor;
				}
			}
			if (chosen < 0) break;
			pending.delete(chosen);
			const wire = this.input.wires[chosen]!;
			const freeIsTo = free === wire.to;
			const mayJoin = freeIsTo ? wire.joinFrom : wire.joinTo;
			const first = connected.size === 1;
			const branch = mayJoin && !first;
			const avoid = this.unconnectedStubs(unit, connected, free!);
			const path = branch
				? this.search(unit, this.treeSources(unit, connected), free!.escape, avoid, chosen, 'tree', connected)
				: (this.facing(unit, wire) ?? this.search(unit, [anchor!.escape], free!.escape, avoid, chosen, 'point'));
			if (path === undefined) return chosen;
			this.commit(chosen, path, branch && freeIsTo, branch && !freeIsTo);
			connected.add(pointKey(free!.point));
		}
		for (const index of loops) {
			const wire = this.input.wires[index]!;
			const path = this.search(unit, [wire.from.escape], wire.to.escape, [], index, 'point');
			if (path === undefined) return index;
			this.commit(index, path, false, false);
		}
		return -1;
	}

	/** Every point on a unit's routed copper is a legal place to branch from. */
	private treeSources(unit: Unit, connected: ReadonlySet<string>): IPoint[] {
		const points: IPoint[] = [];
		for (const piece of this.copper) {
			if (piece.unit === unit.index && (!piece.stub || connected.has(pointKey(piece.a)))) points.push(piece.a, piece.b);
		}
		return points;
	}

	/** Stubs of terminals not yet joined, which a branch must not run into. */
	private unconnectedStubs(unit: Unit, connected: ReadonlySet<string>, target: RouterTerminal): Copper[] {
		return this.copper.filter(
			(piece) =>
				piece.unit === unit.index &&
				piece.stub &&
				!connected.has(pointKey(piece.a)) &&
				!(piece.a.x === target.point.x && piece.a.y === target.point.y)
		);
	}

	/**
	 * Record a found path as copper and as the wire's drawn route.
	 *
	 * The search always runs from where routing starts to the terminal being
	 * reached, so a branch that reaches its `from` end is reversed to keep every
	 * drawn route oriented `from` → `to`.
	 */
	private commit(index: number, path: readonly IPoint[], junctionAtStart: boolean, junctionAtEnd: boolean): void {
		const unit = this.units[this.unitOf[index]!]!;
		for (let step = 1; step < path.length; step += 1) {
			this.copper.push({ a: path[step - 1]!, b: path[step]!, net: unit.net, unit: unit.index, stub: false });
		}
		const wire = this.input.wires[index]!;
		let points: IPoint[];
		if (junctionAtStart) points = compact([...path, wire.to.point]);
		else if (junctionAtEnd) points = compact([wire.from.point, ...[...path].reverse()]);
		else {
			const start = path[0]!;
			const oriented =
				comparePoints(start, wire.from.escape) === 0 || comparePoints(start, wire.from.point) === 0 ? path : [...path].reverse();
			points = compact([wire.from.point, ...oriented, wire.to.point]);
		}
		this.routes[index] = junctionAtStart ? { points, junction: points[0]! } : { points };
		const rect = wire.label?.(points);
		this.labels[index] = rect === undefined ? undefined : { owner: -1 - index, kind: 'label', rect };
	}

	/**
	 * Lattice A* from any of `sources` to `target`, in a window around them.
	 *
	 * Returns the path from a source to `target`, or `undefined` when no path
	 * exists even across the whole canvas.
	 */
	search(
		unit: Unit,
		sources: readonly IPoint[],
		target: IPoint,
		avoid: readonly Copper[],
		wireIndex: number,
		mode: 'tree' | 'point',
		connected: ReadonlySet<string> = new Set()
	): IPoint[] | undefined {
		let box = { minX: target.x, minY: target.y, maxX: target.x, maxY: target.y };
		for (const source of sources) {
			box = { minX: Math.min(box.minX, source.x), minY: Math.min(box.minY, source.y), maxX: Math.max(box.maxX, source.x), maxY: Math.max(box.maxY, source.y) };
		}
		/* A window never excludes its own endpoints, even where an escape point
		   lies just outside the fence. */
		const window = {
			minX: Math.min(box.minX, Math.max(this.canvas.minX, box.minX - WINDOW_MARGIN)),
			minY: Math.min(box.minY, Math.max(this.canvas.minY, box.minY - WINDOW_MARGIN)),
			maxX: Math.max(box.maxX, Math.min(this.canvas.maxX, box.maxX + WINDOW_MARGIN)),
			maxY: Math.max(box.maxY, Math.min(this.canvas.maxY, box.maxY + WINDOW_MARGIN))
		};
		const whole = {
			minX: Math.min(box.minX, this.canvas.minX),
			minY: Math.min(box.minY, this.canvas.minY),
			maxX: Math.max(box.maxX, this.canvas.maxX),
			maxY: Math.max(box.maxY, this.canvas.maxY)
		};
		let area = window;
		let found = this.searchWindow(unit, area, sources, target, avoid, wireIndex, mode, connected, 0, MAX_ROUTER_STATES);
		if (found === undefined && (window.minX !== whole.minX || window.minY !== whole.minY || window.maxX !== whole.maxX || window.maxY !== whole.maxY)) {
			area = whole;
			found = this.searchWindow(unit, area, sources, target, avoid, wireIndex, mode, connected, 0, MAX_ROUTER_STATES);
		}
		if (found === undefined) return undefined;
		/*
		 * A crossing is legal but not free. Priced into the first search it would
		 * make the search exhaust every crossing-free state before accepting the
		 * crossings a bus cannot avoid, so it is priced only here, in a second
		 * search capped at a few times the first one's work: a short detour that
		 * avoids a bridge is found, and an unavoidable crossing costs one bounded
		 * look rather than a flood.
		 */
		if (found.crossings > 0) {
			const better = this.searchWindow(unit, area, sources, target, avoid, wireIndex, mode, connected, CROSS, 2_000 + 4 * found.expanded);
			if (better !== undefined && better.crossings < found.crossings) return better.path;
		}
		return found.path;
	}

	private searchWindow(
		unit: Unit,
		window: IRect,
		sources: readonly IPoint[],
		target: IPoint,
		avoid: readonly Copper[],
		wireIndex: number,
		mode: 'tree' | 'point',
		connected: ReadonlySet<string>,
		crossCost: number,
		cap: number
	): { path: IPoint[]; crossings: number; expanded: number } | undefined {
		const xs = axisCoordinates(this.specialsX, window.minX, window.maxX);
		const ys = axisCoordinates(this.specialsY, window.minY, window.maxY);
		const width = xs.length;
		const height = ys.length;
		const cells = width * height;
		const s = scratch;
		s.begin(cells);
		const col = (x: number): number => {
			const index = lowerBound(xs, x);
			return index < width && xs[index] === x ? index : -1;
		};
		const row = (y: number): number => {
			const index = lowerBound(ys, y);
			return index < height && ys[index] === y ? index : -1;
		};

		/* Obstacles. A component owning one of this unit's terminals — or whose
		   clearance ring holds one of its escape points — blocks only with its body. */
		const relaxed = new Set<number>();
		const unitWires = unit.wires.map((index) => this.input.wires[index]!);
		for (const wire of unitWires) {
			relaxed.add(wire.from.owner);
			relaxed.add(wire.to.owner);
		}
		for (const obstacle of this.input.obstacles) {
			if (obstacle.kind !== 'expanded' || relaxed.has(obstacle.owner)) continue;
			for (const wire of unitWires) {
				for (const terminal of [wire.from, wire.to]) {
					const r = obstacle.rect;
					if (terminal.escape.x > r.minX && terminal.escape.x < r.maxX && terminal.escape.y > r.minY && terminal.escape.y < r.maxY) {
						relaxed.add(obstacle.owner);
					}
				}
			}
		}
		const block = (rect: IRect): void => {
			if (rect.maxX <= window.minX || rect.minX >= window.maxX || rect.maxY <= window.minY || rect.minY >= window.maxY) {
				/* Still blocks edges lying exactly on the window edge from outside? No: an
				   edge must pass through the interior, which lies outside the window. */
				return;
			}
			/* Vertical edges on columns strictly inside, spanning rows that overlap. */
			const c0 = lowerBound(xs, rect.minX + 1);
			const c1 = lowerBound(xs, rect.maxX) - 1;
			const r0 = Math.max(0, lowerBound(ys, rect.minY + 1) - 1);
			const r1 = Math.min(height - 2, lowerBound(ys, rect.maxY) - 1);
			for (let c = c0; c <= c1; c += 1) for (let r = r0; r <= r1; r += 1) s.blockV[r * width + c] = 1;
			const rr0 = lowerBound(ys, rect.minY + 1);
			const rr1 = lowerBound(ys, rect.maxY) - 1;
			const cc0 = Math.max(0, lowerBound(xs, rect.minX + 1) - 1);
			const cc1 = Math.min(width - 2, lowerBound(xs, rect.maxX) - 1);
			for (let r = rr0; r <= rr1; r += 1) for (let c = cc0; c <= cc1; c += 1) s.blockH[r * width + c] = 1;
		};
		for (const obstacle of this.input.obstacles) {
			if (obstacle.kind === 'body') {
				if (relaxed.has(obstacle.owner)) block(obstacle.rect);
			} else if (!relaxed.has(obstacle.owner)) block(obstacle.rect);
		}
		for (const label of this.labels) if (label !== undefined) block(label.rect);

		/* Copper of other nets: occupied edges, and how each touched node is used.
		   In tree mode the unit's own joined copper is marked too, as branch points;
		   a stub's pin end is never one, so no branch leaves from a pin. */
		const mark = (piece: Copper, own: boolean, avoidance: boolean): void => {
			const horizontal = piece.a.y === piece.b.y;
			if (horizontal) {
				const r = row(piece.a.y);
				if (r < 0) return;
				const low = Math.min(piece.a.x, piece.b.x);
				const high = Math.max(piece.a.x, piece.b.x);
				const c0 = lowerBound(xs, low);
				for (let c = c0; c < width && xs[c]! <= high; c += 1) {
					const cell = r * width + c;
					const end = xs[c] === low || xs[c] === high;
					if (avoidance) s.node[cell] = s.node[cell]! | (AVOID);
					else if (own) {
						if (!(piece.stub && xs[c] === piece.a.x)) s.node[cell] = s.node[cell]! | (OWN);
					} else s.node[cell] = s.node[cell]! | (end ? OTHER_END : OTHER_H);
					if (xs[c]! < high && c + 1 < width) {
						if (own || avoidance) s.occH[cell] = 2;
						else s.occH[cell] = 1;
					}
				}
			} else {
				const c = col(piece.a.x);
				if (c < 0) return;
				const low = Math.min(piece.a.y, piece.b.y);
				const high = Math.max(piece.a.y, piece.b.y);
				const r0 = lowerBound(ys, low);
				for (let r = r0; r < height && ys[r]! <= high; r += 1) {
					const cell = r * width + c;
					const end = ys[r] === low || ys[r] === high;
					if (avoidance) s.node[cell] = s.node[cell]! | (AVOID);
					else if (own) {
						if (!(piece.stub && ys[r] === piece.a.y)) s.node[cell] = s.node[cell]! | (OWN);
					} else s.node[cell] = s.node[cell]! | (end ? OTHER_END : OTHER_V);
					if (ys[r]! < high && r + 1 < height) {
						if (own || avoidance) s.occV[cell] = 2;
						else s.occV[cell] = 1;
					}
				}
			}
		};
		for (const piece of this.copper) {
			const minX = Math.min(piece.a.x, piece.b.x);
			const maxX = Math.max(piece.a.x, piece.b.x);
			const minY = Math.min(piece.a.y, piece.b.y);
			const maxY = Math.max(piece.a.y, piece.b.y);
			if (maxX < window.minX || minX > window.maxX || maxY < window.minY || minY > window.maxY) continue;
			if (piece.net !== unit.net) mark(piece, false, false);
			else if (mode === 'tree' && piece.unit === unit.index && (!piece.stub || connected.has(pointKey(piece.a)))) mark(piece, true, false);
		}
		for (const piece of avoid) mark(piece, false, true);
		/* Fixed diagonal wires of other nets: any lattice edge touching one is occupied. */
		for (const fixed of this.input.fixed) {
			if (fixed.net === unit.net) continue;
			const minX = Math.min(fixed.a.x, fixed.b.x);
			const maxX = Math.max(fixed.a.x, fixed.b.x);
			const minY = Math.min(fixed.a.y, fixed.b.y);
			const maxY = Math.max(fixed.a.y, fixed.b.y);
			if (maxX < window.minX || minX > window.maxX || maxY < window.minY || minY > window.maxY) continue;
			const c0 = Math.max(0, lowerBound(xs, minX) - 1);
			const c1 = Math.min(width - 1, lowerBound(xs, maxX + 1));
			const r0 = Math.max(0, lowerBound(ys, minY) - 1);
			const r1 = Math.min(height - 1, lowerBound(ys, maxY + 1));
			for (let r = r0; r <= r1; r += 1) {
				for (let c = c0; c <= c1; c += 1) {
					const here = { x: xs[c]!, y: ys[r]! };
					if (c + 1 < width && segmentContact(here, { x: xs[c + 1]!, y: ys[r]! }, fixed.a, fixed.b) !== undefined) s.occH[r * width + c] = 1;
					if (r + 1 < height && segmentContact(here, { x: xs[c]!, y: ys[r + 1]! }, fixed.a, fixed.b) !== undefined) s.occV[r * width + c] = 1;
				}
			}
		}
		/* History at contested locations. */
		if (this.history.size > 0) {
			for (const [key, value] of this.history) {
				const comma = key.indexOf(',');
				const c = col(Number(key.slice(0, comma)));
				const r = row(Number(key.slice(comma + 1)));
				if (c >= 0 && r >= 0) s.history[r * width + c] = value;
			}
		}

		/* A branch may not leave a point where its own tree already meets three ways. */
		const targetCol = col(target.x);
		const targetRow = row(target.y);
		/* v8 ignore next -- the target is an escape point, which every window includes. */
		if (targetCol < 0 || targetRow < 0) return undefined;
		const targetCell = targetRow * width + targetCol;
		const startCells: number[] = [];
		if (mode === 'point') {
			for (const source of sources) {
				const c = col(source.x);
				const r = row(source.y);
				if (c >= 0 && r >= 0) startCells.push(r * width + c);
			}
		}
		if (mode === 'tree') {
			/* Pins of the unit: a junction held two pitches off them, so its dot can
			   never crowd a pin's own. */
			const pins: IPoint[] = [];
			for (const wire of unitWires) pins.push(wire.from.point, wire.to.point);
			/* Every lattice node on the unit's routed copper is a branch point, except
			   where three or more of its wires already meet. */
			for (let cell = 0; cell < cells; cell += 1) {
				if ((s.node[cell]! & OWN) === 0) continue;
				const c = cell % width;
				const r = (cell - c) / width;
				let degree = 0;
				if (c > 0 && s.occH[cell - 1] === 2) degree += 1;
				if (c + 1 < width && s.occH[cell] === 2) degree += 1;
				if (r > 0 && s.occV[cell - width] === 2) degree += 1;
				if (r + 1 < height && s.occV[cell] === 2) degree += 1;
				const x = xs[c]!;
				const y = ys[r]!;
				const crowded = pins.some((pin) => Math.abs(pin.x - x) + Math.abs(pin.y - y) < 2 * PITCH);
				if (degree >= 3) s.node[cell] = s.node[cell]! | (OWN_JUNCTION);
				else if (!crowded) startCells.push(cell);
			}
		}

		/* Manhattan distance plus the bends still unavoidable from this heading — a
		   lower bound that stays consistent, so A* remains exact. */
		const heuristic = (cell: number, direction: number): number => {
			const c = cell % width;
			const r = (cell - c) / width;
			const dx = xs[c]! - target.x;
			const dy = ys[r]! - target.y;
			const bends = direction === 0 ? (dx !== 0 && dy !== 0 ? 1 : 0) : direction === 1 ? (dy !== 0 ? 1 : 0) : dx !== 0 ? 1 : 0;
			return Math.abs(dx) + Math.abs(dy) + bends * BEND;
		};
		for (const cell of startCells) {
			if ((s.node[cell]! & OWN_JUNCTION) !== 0) continue;
			const state = cell * 3;
			if (s.known(state) === 0) continue;
			s.relax(state, -1, 0);
			s.push(state, 0, heuristic(cell, 0));
		}
		const contact = this.contact;
		let expanded = 0;
		let found = -1;
		while (s.size > 0) {
			const g = s.heapG[0]!;
			const state = s.pop();
			if (s.known(state) !== g) continue;
			const cell = (state / 3) | 0;
			if (cell === targetCell) {
				found = state;
				break;
			}
			if (++expanded > cap) {
				if (crossCost > 0) return undefined;
				throw new RouterComplexityError(wireIndex);
			}
			const direction = state - cell * 3;
			const c = cell % width;
			const r = (cell - c) / width;
			const flags = s.node[cell]!;
			for (let step = 0; step < 4; step += 1) {
				let next: number;
				let edge: number;
				let length: number;
				let occ: number;
				const nextDirection = step < 2 ? 1 : 2;
				if (step === 0) {
					if (c === 0) continue;
					next = cell - 1;
					edge = cell - 1;
					if (s.blockH[edge]) continue;
					occ = s.occH[edge]!;
					length = xs[c]! - xs[c - 1]!;
				} else if (step === 1) {
					if (c + 1 === width) continue;
					next = cell + 1;
					edge = cell;
					if (s.blockH[edge]) continue;
					occ = s.occH[edge]!;
					length = xs[c + 1]! - xs[c]!;
				} else if (step === 2) {
					if (r === 0) continue;
					next = cell - width;
					edge = cell - width;
					if (s.blockV[edge]) continue;
					occ = s.occV[edge]!;
					length = ys[r]! - ys[r - 1]!;
				} else {
					if (r + 1 === height) continue;
					next = cell + width;
					edge = cell;
					if (s.blockV[edge]) continue;
					occ = s.occV[edge]!;
					length = ys[r + 1]! - ys[r]!;
				}
				/* Never run along the unit's own copper, or into an unjoined stub. */
				if (occ === 2) continue;
				let cost = g + length;
				let crossed = s.crossings[state]!;
				let penalty = 0;
				if (occ === 1) penalty += contact + s.history[cell]!;
				if (direction !== 0 && direction !== nextDirection) {
					cost += BEND;
					if ((flags & (OTHER_H | OTHER_V | OTHER_END)) !== 0) penalty += contact + s.history[cell]!;
				} else if (direction === nextDirection) {
					if ((flags & OTHER_END) !== 0) penalty += contact + s.history[cell]!;
					else if ((nextDirection === 1 && (flags & OTHER_V) !== 0) || (nextDirection === 2 && (flags & OTHER_H) !== 0)) {
						crossed += 1;
						cost += crossCost;
					}
				} else if ((flags & (OTHER_H | OTHER_V | OTHER_END)) !== 0) {
					penalty += contact + s.history[cell]!;
				}
				const nextFlags = s.node[next]!;
				if ((nextFlags & AVOID) !== 0) continue;
				if ((nextFlags & OWN_JUNCTION) !== 0) continue;
				if (next === targetCell && (nextFlags & (OTHER_H | OTHER_V | OTHER_END)) !== 0) penalty += contact + s.history[next]!;
				if (penalty > 0) {
					if (penalty === Number.POSITIVE_INFINITY) continue;
					cost += penalty;
				}
				const nextState = next * 3 + nextDirection;
				if (!s.improves(nextState, cost, crossed)) continue;
				s.relax(nextState, state, cost, crossed);
				s.push(nextState, cost, cost + heuristic(next, nextDirection));
			}
		}
		if (found < 0) return undefined;
		const reversed: IPoint[] = [];
		for (let state = found; state !== -1; state = s.previous[state]!) {
			const cell = (state / 3) | 0;
			const c = cell % width;
			reversed.push({ x: xs[c]!, y: ys[(cell - c) / width]! });
		}
		return { path: compact(reversed.reverse()), crossings: s.crossings[found]!, expanded };
	}

	/** Find every location where copper of two different nets touches. */
	contacts(): Map<number, IPoint> {
		const involved = new Map<number, IPoint>();
		const horizontal = new Map<number, Copper[]>();
		const vertical = new Map<number, Copper[]>();
		for (const piece of this.copper) {
			if (piece.a.x === piece.b.x && piece.a.y === piece.b.y) continue;
			const isH = piece.a.y === piece.b.y;
			const map = isH ? horizontal : vertical;
			const key = isH ? piece.a.y : piece.a.x;
			const list = map.get(key);
			if (list === undefined) map.set(key, [piece]);
			else list.push(piece);
		}
		const flag = (left: Copper, right: Copper, at: IPoint): void => {
			if (!involved.has(left.unit)) involved.set(left.unit, at);
			if (!involved.has(right.unit)) involved.set(right.unit, at);
			const key = pointKey(at);
			this.contested.add(key);
		};
		const span = (piece: Copper, isH: boolean): [number, number] =>
			isH ? [Math.min(piece.a.x, piece.b.x), Math.max(piece.a.x, piece.b.x)] : [Math.min(piece.a.y, piece.b.y), Math.max(piece.a.y, piece.b.y)];
		for (const [isH, map] of [[true, horizontal], [false, vertical]] as const) {
			for (const [line, list] of map) {
				list.sort((left, right) => span(left, isH)[0] - span(right, isH)[0]);
				for (let i = 0; i < list.length; i += 1) {
					const [lowI, highI] = span(list[i]!, isH);
					for (let j = i + 1; j < list.length; j += 1) {
						const [lowJ, highJ] = span(list[j]!, isH);
						if (lowJ > highI) break;
						if (list[i]!.net === list[j]!.net) continue;
						const at = Math.max(lowI, lowJ);
						flag(list[i]!, list[j]!, isH ? { x: at, y: line } : { x: line, y: at });
						void highJ;
					}
				}
			}
		}
		/* Perpendicular contact that is not a clean crossing: an end or corner of one
		   wire lying on another. */
		for (const piece of this.copper) {
			const isH = piece.a.y === piece.b.y;
			for (const end of [piece.a, piece.b]) {
				const others = (isH ? vertical : horizontal).get(isH ? end.x : end.y);
				if (others === undefined) continue;
				for (const other of others) {
					if (other.net === piece.net) continue;
					const [low, high] = span(other, !isH);
					const along = isH ? end.y : end.x;
					if (along >= low && along <= high) flag(piece, other, end);
				}
			}
		}
		for (const fixed of this.input.fixed) {
			for (const piece of this.copper) {
				if (piece.net === fixed.net) continue;
				if (segmentContact(piece.a, piece.b, fixed.a, fixed.b) !== undefined) {
					if (!involved.has(piece.unit)) involved.set(piece.unit, piece.a);
					this.contested.add(pointKey(piece.a));
				}
			}
		}
		return involved;
	}

	readonly contested = new Set<string>();
}

/** Thrown when one search exhausts its state budget. */
export class RouterComplexityError extends Error {
	constructor(readonly wire: number) {
		super('router state budget exhausted');
	}
}

/** Remove repeated points and collinear interior corners. */
export function compact(points: readonly IPoint[]): IPoint[] {
	const out: IPoint[] = [];
	for (const point of points) {
		const last = out[out.length - 1];
		if (last !== undefined && last.x === point.x && last.y === point.y) continue;
		out.push(point);
	}
	let index = 1;
	while (index < out.length - 1) {
		const a = out[index - 1]!;
		const b = out[index]!;
		const c = out[index + 1]!;
		if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(index, 1);
		else index += 1;
	}
	return out;
}

/**
 * Route every orthogonal wire.
 *
 * @returns Routes indexed like `input.wires`, plus the negotiation report.
 */
export function routeWires(input: RouterInput): RouterResult {
	const router = new Router(input);
	router.seedStubs();
	const rippedUp: { wire: number; attempt: number }[] = [];
	const fail = (wire: number, reason: NonNullable<RouterResult['reason']>, attempts: number): RouterResult => ({
		wires: [],
		attempts,
		rippedUp,
		failed: wire,
		reason
	});
	try {
		/* Pass one: contact forbidden. A unit that cannot be placed that way is
		   placed at a price and left for negotiation. */
		const soft: Unit[] = [];
		for (const unit of router.units) {
			router.contact = Number.POSITIVE_INFINITY;
			const failed = router.routeUnit(unit);
			if (failed < 0) continue;
			router.ripUp(unit);
			if (input.attempts <= 1) return fail(failed, 'contention', 0);
			router.contact = CONTACT;
			const retry = router.routeUnit(unit);
			if (retry >= 0) return fail(retry, 'unroutable', 0);
			soft.push(unit);
		}
		let involved = router.contacts();
		let attempt = 1;
		while (involved.size > 0) {
			if (attempt >= input.attempts) {
				const wires = [...involved.keys()].flatMap((unit) => router.units[unit]!.wires);
				return fail(Math.min(...wires), 'contention', attempt);
			}
			for (const key of router.contested) router.history.set(key, (router.history.get(key) ?? 0) + HISTORY * attempt);
			router.contested.clear();
			const units = [...involved.keys()].sort((left, right) => left - right).map((index) => router.units[index]!);
			for (const unit of units) {
				router.ripUp(unit);
				for (const wire of unit.wires) rippedUp.push({ wire, attempt });
			}
			router.contact = CONTACT * 2 ** attempt;
			for (const unit of units) {
				const failed = router.routeUnit(unit);
				/* v8 ignore next -- the same unit routed softly in pass one, and nothing
				   has been added to the canvas since that could wall it in. */
				if (failed >= 0) return fail(failed, 'unroutable', attempt);
			}
			attempt += 1;
			involved = router.contacts();
		}
		return { wires: router.routes.map((route) => route!), attempts: attempt - 1, rippedUp };
	} catch (error) {
		if (error instanceof RouterComplexityError) return fail(error.wire, 'complexity', 0);
		/* v8 ignore next -- anything else is a defect; rethrow it untouched. */
		throw error;
	}
}
