/**
 * The symbol registry: one {@link KindDef} per component kind, and the placed
 * geometry every other pass reads from it.
 *
 * @module
 */
import { rotate, toMilli, type IPoint, type Turn } from '../geom.js';
import type { SchematicComponent } from '../types.js';
import type { KindDef, LocalPort } from './common.js';
import { ELECTRICAL_KINDS } from './electrical.js';
import { LOGIC_KINDS } from './logic.js';
import { QUANTUM_KINDS } from './quantum.js';
import { UML_KINDS } from './uml.js';

/** Every kind the DSL accepts, mapped to its definition. */
export const KINDS: Readonly<Record<string, KindDef>> = {
	...ELECTRICAL_KINDS,
	...LOGIC_KINDS,
	...QUANTUM_KINDS,
	...UML_KINDS
} as unknown as Readonly<Record<string, KindDef>>;

/** The definition of a validated component's kind. */
export function definition(component: SchematicComponent): KindDef {
	return KINDS[component.kind]!;
}

const TURNS: Readonly<Record<string, Turn>> = { right: 0, down: 1, left: 2, up: 3 };

/** A component's clockwise quarter turns. */
export function turnOf(component: SchematicComponent): Turn {
	return 'orientation' in component && component.orientation !== undefined ? TURNS[component.orientation]! : 0;
}

/** A terminal in absolute milli-units. */
export interface PlacedPort {
	readonly id: string;
	readonly point: IPoint;
	readonly normal: IPoint;
}

function placedPort(component: SchematicComponent, local: LocalPort): PlacedPort {
	const turn = turnOf(component);
	const offset = rotate({ x: local.x, y: local.y }, turn);
	return {
		id: local.id,
		point: { x: toMilli(component.x) + offset.x, y: toMilli(component.y) + offset.y },
		normal: rotate({ x: local.nx, y: local.ny }, turn)
	};
}

/* Placed geometry is cached per frozen component; a component still being
   placed by relation can move, so it is never cached. */
const portCache = new WeakMap<SchematicComponent, readonly PlacedPort[]>();

/** Each physical terminal once, placed. */
export function placedPorts(component: SchematicComponent): readonly PlacedPort[] {
	const cached = portCache.get(component);
	if (cached !== undefined) return cached;
	const ports = definition(component).ports(component).map((local) => placedPort(component, local));
	if (Object.isFrozen(component)) portCache.set(component, ports);
	return ports;
}

/** Any accepted terminal spelling, placed, or `undefined`. */
export function resolvePlaced(component: SchematicComponent, name: string): PlacedPort | undefined {
	const local = definition(component).resolve(component, name);
	return local === undefined ? undefined : placedPort(component, local);
}

/**
 * The canonical id of the terminal a spelling addresses.
 *
 * A name that is itself a terminal maps to itself; an alias maps to the terminal
 * drawn at the same point; a valid name no terminal occupies keeps its spelling.
 */
export function canonicalName(component: SchematicComponent, name: string): string | undefined {
	const local = definition(component).resolve(component, name);
	if (local === undefined) return undefined;
	const ports = definition(component).ports(component);
	if (ports.some((entry) => entry.id === local.id)) return local.id;
	return ports.find((entry) => entry.x === local.x && entry.y === local.y)?.id ?? local.id;
}

/** Body half-extents after rotation, in milli-units. */
export function halfExtents(component: SchematicComponent): readonly [number, number] {
	const [w, h] = definition(component).extents(component);
	return turnOf(component) % 2 === 1 ? [h, w] : [w, h];
}
