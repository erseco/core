/**
 * Drawing invariants over generated documents.
 *
 * A seeded generator builds documents from every family — random kinds,
 * orientations, positions and connections, with shared terminals, named nets,
 * labels and markers — and every one that compiles is held to the rules a
 * draughtsman would check by eye. The defects these caught when they were
 * written are listed in the changelog; each one now fails here if it returns.
 *
 * Two things are deliberately not checked: wires through text where a pin's
 * own exit point already sits inside text (a placement collision no route can
 * avoid), and junctions where several arrowed wires must each reach one pin.
 */
import { describe, expect, test } from 'vitest';

import {
	compileSchematic,
	componentObstacleRectangle,
	enumerateComponentPorts,
	parseSchematic,
	resolvePortPoint,
	routeConnections,
	SchematicSyntaxError,
	type RoutedConnection,
	type SchematicComponent,
	type SchematicDocument
} from '../src/index.js';

type Segment = readonly [number, number, number, number];
interface Point {
	readonly x: number;
	readonly y: number;
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const KINDS: readonly (readonly [string, string])[] = [
	['resistor', ''], ['capacitor', ''], ['inductor', ''], ['diode', ''], ['transistor', '[type=npn]'], ['transistor', '[type=nmos]'],
	['port', ''], ['junction', '-'], ['source', '[type=voltage-dc]'], ['ground', '-'], ['switch', '[type=spdt]'], ['and', '[inputs=3]'],
	['nand', ''], ['not', ''], ['flipflop', '[type=d]'], ['mux', '[inputs=4]'], ['register', ''], ['ic', '[left="A,B,C" right="Y,Z"]'],
	['amplifier', '[type=opamp]'], ['hadamard', ''], ['cnot', ''], ['measure', ''], ['class', '-'], ['state', '-'], ['testpoint', '-']
];
const LABELS = ['R', 'Load', '1 k\\Omega', 'Microcontroller', 'V_{out}', 'x', 'Sensor input', 'Q'];
const UML = new Set(['class', 'state', 'action']);

function generate(seed: number, dense: boolean): { source: string; fence: { bounds: { width: number; height: number }; title: string }; lines: string[]; wires: string[] } | undefined {
	const next = random(seed);
	const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
	const width = 600 + Math.floor(next() * 5) * 200;
	const height = 400 + Math.floor(next() * 4) * 150;
	const count = 3 + Math.floor(next() * 9);
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const [kind, option] = pick(KINDS);
		const x = 80 + Math.floor(next() * ((width - 160) / 20)) * 20;
		const y = 80 + Math.floor(next() * ((height - 160) / 20)) * 20;
		let options = option === '-' ? '' : option;
		if (option !== '-' && next() < 0.5) {
			const turn = `orientation=${pick(['right', 'down', 'left', 'up'])}`;
			options = options === '' ? `[${turn}]` : options.replace(']', ` ${turn}]`);
		}
		lines.push(`${kind}:C${index} "${pick(LABELS)}" at (${x}, ${y}) #${pick(['amber', 'blue', 'cyan', 'slate'])}${options === '' ? '' : ` ${options}`}`);
	}
	const fence = { bounds: { width, height }, title: `property ${seed}` };
	let document: SchematicDocument;
	try {
		document = parseSchematic(lines.join('\n'), fence);
	} catch {
		return undefined;
	}
	const ports = document.components.map((component) => ({ id: component.id, ports: enumerateComponentPorts(component).map((port) => port.id), uml: UML.has(component.kind) }));
	const hubs = ports.slice(0, 3);
	const wires: string[] = [];
	const total = dense ? count + Math.floor(next() * count * 2) : 1 + Math.floor(next() * (count + 2));
	for (let index = 0; index < total; index += 1) {
		const a = dense && next() < 0.5 ? pick(hubs) : pick(ports);
		const b = pick(ports);
		if (a.id === b.id || a.ports.length === 0 || b.ports.length === 0 || a.uml !== b.uml) continue;
		const extras = [next() < 0.8 ? 'ortho' : next() < 0.5 ? 'line' : 'bezier'];
		if (a.uml) extras.push('association');
		if (!a.uml && next() < 0.15) extras.push(`net=N${Math.floor(next() * 2)}`);
		if (next() < 0.1) extras.push('label="bus"');
		if (next() < 0.1) extras.push('arrow');
		wires.push(`${a.id}.${dense && next() < 0.6 ? a.ports[0] : pick(a.ports)} -> ${b.id}.${pick(b.ports)} #blue [${extras.join(' ')}]`);
	}
	return { source: [...lines, ...wires].join('\n'), fence, lines, wires };
}

function segments(d: string): Segment[] | undefined {
	const tokens = d.trim().split(/[\s,]+/);
	const out: Segment[] = [];
	let x = 0;
	let y = 0;
	for (let index = 0; index < tokens.length; ) {
		const command = tokens[index++];
		if (command === 'M') {
			x = Number(tokens[index++]);
			y = Number(tokens[index++]);
		} else if (command === 'H') {
			const to = Number(tokens[index++]);
			out.push([x, y, to, y]);
			x = to;
		} else if (command === 'V') {
			const to = Number(tokens[index++]);
			out.push([x, y, x, to]);
			y = to;
		} else if (command === 'A') {
			index += 5;
			x = Number(tokens[index++]);
			y = Number(tokens[index++]);
		} else return undefined;
	}
	return out;
}

const EPS = 1e-6;
const within = (value: number, a: number, b: number) => value >= Math.min(a, b) - EPS && value <= Math.max(a, b) + EPS;
const strictly = (value: number, a: number, b: number) => value > Math.min(a, b) + EPS && value < Math.max(a, b) - EPS;
const horizontal = (s: Segment) => s[1] === s[3];
const onSegment = (p: Point, s: Segment) => within(p.x, s[0], s[2]) && within(p.y, s[1], s[3]) && (horizontal(s) ? Math.abs(p.y - s[1]) < EPS : Math.abs(p.x - s[0]) < EPS);
function touch(a: Segment, b: Segment): boolean {
	if (horizontal(a) && horizontal(b)) return Math.abs(a[1] - b[1]) < EPS && Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2])) <= Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2])) + EPS;
	if (!horizontal(a) && !horizontal(b)) return Math.abs(a[0] - b[0]) < EPS && Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3])) <= Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3])) + EPS;
	const [h, v] = horizontal(a) ? [a, b] : [b, a];
	return within(v[0], h[0], h[2]) && within(h[1], v[1], v[3]);
}
function overlap(a: Segment, b: Segment): number {
	if (horizontal(a) !== horizontal(b)) return 0;
	if (horizontal(a) ? Math.abs(a[1] - b[1]) > EPS : Math.abs(a[0] - b[0]) > EPS) return 0;
	const [a0, a1, b0, b1] = horizontal(a) ? [a[0], a[2], b[0], b[2]] : [a[1], a[3], b[1], b[3]];
	return Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1));
}
function enters(s: Segment, r: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
	return horizontal(s)
		? s[1] > r.minY + EPS && s[1] < r.maxY - EPS && Math.max(s[0], s[2]) > r.minX + EPS && Math.min(s[0], s[2]) < r.maxX - EPS
		: s[0] > r.minX + EPS && s[0] < r.maxX - EPS && Math.max(s[1], s[3]) > r.minY + EPS && Math.min(s[1], s[3]) < r.maxY - EPS;
}

/** Wires the router lets touch: shared terminals, net ids and net names. */
function nets(document: SchematicDocument): number[] {
	const parent = document.connections.map((_, index) => index);
	const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
	const owner = new Map<string, number>();
	document.connections.forEach((connection, index) => {
		for (const key of [`T${connection.from.componentId}.${connection.from.port}`, `T${connection.to.componentId}.${connection.to.port}`, connection.netId === undefined ? '' : `N${connection.netId}`, connection.net === undefined ? '' : `M${connection.net}`]) {
			if (key === '') continue;
			const first = owner.get(key);
			if (first === undefined) owner.set(key, index);
			else parent[find(index)] = find(first);
		}
	});
	return document.connections.map((_, index) => find(index));
}

function violations(document: SchematicDocument, routes: readonly RoutedConnection[]): string[] {
	const problems: string[] = [];
	const components = new Map<string, SchematicComponent>(document.components.map((component) => [component.id, component]));
	const net = nets(document);
	const wired = new Set(document.connections.flatMap((c) => [`${c.from.componentId}.${c.from.port}`, `${c.to.componentId}.${c.to.port}`]));
	const traces = routes.map((route) => (route.curve === 'ortho' ? segments(route.d) : undefined));
	const key = (end: { componentId: string; port: string }) => `${end.componentId}.${end.port}`;
	const covered = (i: number, a: Segment) =>
		traces.reduce((sum, t, j) => sum + (t !== undefined && j !== i && net[j] === net[i] ? t.reduce((inner, b) => inner + Math.max(0, overlap(a, b)), 0) : 0), 0) >=
		Math.abs(a[0] - a[2]) + Math.abs(a[1] - a[3]) - 0.01;
	const redundant = traces.map((t, i) => t !== undefined && t.every((a) => covered(i, a)));
	for (let i = 0; i < traces.length; i += 1) {
		const a = traces[i];
		if (a === undefined) continue;
		const connection = document.connections[i]!;
		/* Ends on its own pins, or on its own net. */
		const last = resolvePortPoint(components.get(connection.to.componentId)!, connection.to.port);
		const tip = a.length === 0 ? undefined : { x: a.at(-1)![2], y: a.at(-1)![3] };
		if (tip !== undefined && (Math.abs(tip.x - last.x) > 1e-3 || Math.abs(tip.y - last.y) > 1e-3) && !traces.some((t, j) => t !== undefined && j !== i && net[j] === net[i] && t.some((s) => onSegment(tip, s)))) {
			problems.push(`wire ${i} ends off its pin and its net`);
		}
		for (const component of document.components) {
			const body = componentObstacleRectangle(component, 0);
			const own = component.id === connection.from.componentId || component.id === connection.to.componentId;
			a.forEach((s, k) => {
				if (enters(s, body) && !(own && (k === 0 || k === a.length - 1))) problems.push(`wire ${i} runs through ${component.id}`);
			});
			for (const port of enumerateComponentPorts(component)) {
				if (wired.has(`${component.id}.${port.id}`)) continue;
				if (a.some((s) => onSegment(port.point, s))) problems.push(`wire ${i} passes free pin ${component.id}.${port.id}`);
			}
		}
		for (let j = i + 1; j < traces.length; j += 1) {
			const b = traces[j];
			if (b === undefined) continue;
			if (net[i] !== net[j]) {
				if (a.some((s) => b.some((t) => touch(s, t)))) problems.push(`wires ${i} and ${j} of separate nets touch`);
				continue;
			}
			const other = document.connections[j]!;
			const sameEnds = [key(connection.from), key(connection.to)].sort().join() === [key(other.from), key(other.to)].sort().join();
			for (const s of a) {
				for (const t of b) {
					if (horizontal(s) !== horizontal(t)) {
						const [h, v] = horizontal(s) ? [s, t] : [t, s];
						const dotted = routes.some((route) => (route.joins ?? []).some((p) => Math.abs(p.x - v[0]) < EPS && Math.abs(p.y - h[1]) < EPS));
						if (strictly(v[0], h[0], h[2]) && strictly(h[1], v[1], v[3]) && !dotted) problems.push(`wires ${i} and ${j} cross their own net without a dot`);
					} else if (!sameEnds && !redundant[i] && !redundant[j] && overlap(s, t) > 0.5) {
						const shared = [connection.from, connection.to].filter((e) => [other.from, other.to].some((f) => key(f) === key(e)));
						const lead = shared.some((e) => {
							const port = enumerateComponentPorts(components.get(e.componentId)!).find((p) => p.id === e.port)!;
							return (onSegment(port.point, s) || onSegment(port.point, t)) && (port.normal.x === 0 ? !horizontal(s) && Math.abs(s[0] - port.point.x) < EPS : horizontal(s) && Math.abs(s[1] - port.point.y) < EPS);
						});
						if (!lead) problems.push(`wires ${i} and ${j} of one net are drawn over each other`);
					}
				}
			}
		}
		const junction = routes[i]!.junction;
		if (junction !== undefined && !traces.some((t, j) => t !== undefined && j !== i && net[j] === net[i] && t.some((s) => onSegment(junction, s)))) {
			problems.push(`wire ${i} has a junction on nothing`);
		}
	}
	return problems;
}

function shuffle<T>(list: readonly T[], next: () => number): T[] {
	const out = [...list];
	for (let index = out.length - 1; index > 0; index -= 1) {
		const other = Math.floor(next() * (index + 1));
		[out[index], out[other]] = [out[other]!, out[index]!];
	}
	return out;
}

function traceSet(svg: string): string {
	return [...svg.matchAll(/data-wire-source="([^"]+)" data-wire-target="([^"]+)"[^>]*>(?:<[^>]*>)*?<path[^>]*schematic-trace[^"]*" d="([^"]+)"/g)]
		.map((match) => `${match[1]}>${match[2]}:${match[3]}`)
		.sort()
		.join('\n');
}

describe.each([
	['sparse documents', false, 1, 400],
	['dense nets', true, 1, 250]
] as const)('%s', (_, dense, from, to) => {
	test('every compiled drawing keeps the draughting invariants, and its order does not matter', () => {
		let compiled = 0;
		const failures: string[] = [];
		for (let seed = from; seed <= to; seed += 1) {
			const generated = generate(seed, dense);
			if (generated === undefined) continue;
			let result: ReturnType<typeof compileSchematic>;
			try {
				result = compileSchematic(generated.source, { ...generated.fence, mode: 'full' });
			} catch (error) {
				if (!(error instanceof SchematicSyntaxError)) failures.push(`#${seed} crashed: ${String(error)}`);
				continue;
			}
			compiled += 1;
			const routes = routeConnections(result.document.connections, new Map(result.document.components.map((c) => [c.id, c])), generated.fence.bounds);
			for (const problem of violations(result.document, routes)) failures.push(`#${seed} ${problem}`);
			const next = random(seed * 7 + 1);
			const reordered = compileSchematic([...shuffle(generated.lines, next), ...shuffle(generated.wires, next)].join('\n'), { ...generated.fence, mode: 'full' });
			if (traceSet(reordered.svg) !== traceSet(result.svg)) failures.push(`#${seed} drawing depends on declaration order`);
		}
		expect(failures.slice(0, 10)).toEqual([]);
		expect(compiled).toBeGreaterThan(dense ? 40 : 80);
	});
});
