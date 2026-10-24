/**
 * `fit=wires`: parts that take their height from their wires.
 *
 * A block with several terminals on a side has a fixed pitch, so the wires
 * feeding it bend to meet its pins: three qubit rails 100 units apart jog in to
 * a CNOT whose rails are 18 apart, and out again. A part declared `fit=wires`
 * turns that round. Each of its terminals takes the height of the terminal it
 * is wired to, the part is centred between them, and a block's body grows to
 * hold them, so the wires arrive straight.
 *
 * What lines up:
 *
 * - a multi-track quantum gate's rails (CNOT, swap, controlled gates, barrier,
 *   delay): one height per qubit, taken from its input's wire, or its output's
 *   when the input is unwired. Rails may come in any order, so a CNOT whose
 *   control sits below its target needs no special syntax;
 * - a block's left and right pins (ICs and digital blocks): each side keeps its
 *   terminals in their declared order, top to bottom.
 *
 * A terminal with no wire is spaced from its wired neighbours at the part's
 * usual pitch. A part with nothing wired to those terminals keeps its usual
 * shape. Fitted parts are settled left to right — then top to bottom, then by
 * id — and each reads only the parts settled before it, so a chain of CNOTs
 * fits from its first gate onwards and the result never depends on the order
 * the declarations were written in.
 *
 * Placement runs first, so a part placed relative to a fitted one is measured
 * against its unfitted shape.
 *
 * @module
 */
import { fromMilli, roundDiv, toMilli } from './geom.js';
import { resolvePortPoint } from './layout.js';
import { definition } from './symbols/index.js';
import {
	SchematicSyntaxError,
	type DigitalComponent,
	type IcComponent,
	type QuantumGateComponent,
	type QuantumSpecialComponent,
	type SchematicComponent,
	type SchematicConnection
} from './types.js';

/** The least distance between two fitted terminals: a router channel and a clearance. */
export const FIT_GAP = 16;

type Fitted = (IcComponent | DigitalComponent | QuantumGateComponent | QuantumSpecialComponent) & { fit: 'wires' };

function isFitted(component: SchematicComponent): component is Fitted {
	return 'fit' in component && component.fit === 'wires';
}

/** Where one terminal's wire arrives, in milli-units, or `undefined` if nothing settled is wired to it. */
function arrival(
	component: SchematicComponent,
	port: string,
	connections: readonly SchematicConnection[],
	byId: ReadonlyMap<string, SchematicComponent>,
	pending: ReadonlySet<string>
): number | undefined {
	let best: { dx: number; y: number; key: string } | undefined;
	for (const connection of connections) {
		const [near, far] =
			connection.from.componentId === component.id && connection.from.port === port
				? [connection.from, connection.to]
				: connection.to.componentId === component.id && connection.to.port === port
					? [connection.to, connection.from]
					: [undefined, undefined];
		if (near === undefined || far.componentId === component.id || pending.has(far.componentId)) continue;
		const point = resolvePortPoint(byId.get(far.componentId)!, far.port);
		const candidate = { dx: Math.abs(toMilli(point.x) - toMilli(component.x)), y: toMilli(point.y), key: `${far.componentId}.${far.port}` };
		/* The nearest wired terminal along the part's axis decides; ties go to the
		   higher one, then to the name, so the choice never rests on source order. */
		if (
			best === undefined ||
			candidate.dx < best.dx ||
			(candidate.dx === best.dx && (candidate.y < best.y || (candidate.y === best.y && candidate.key < best.key)))
		) {
			best = candidate;
		}
	}
	return best?.y;
}

/** Fill unwired slots from their wired neighbours: between two by interpolation, beyond them at `pitch`. */
function fill(known: readonly (number | undefined)[], pitch: number): number[] | undefined {
	const wired = known.flatMap((value, index) => (value === undefined ? [] : [index]));
	if (wired.length === 0) return undefined;
	const first = wired[0]!;
	const last = wired.at(-1)!;
	return known.map((value, index) => {
		if (value !== undefined) return value;
		if (index < first) return known[first]! - (first - index) * pitch;
		if (index > last) return known[last]! + (index - last) * pitch;
		const below = wired.filter((entry) => entry < index).at(-1)!;
		const above = wired.find((entry) => entry > index)!;
		return known[below]! + roundDiv((known[above]! - known[below]!) * (index - below), above - below);
	});
}

function units(milli: number): string {
	return String(fromMilli(milli));
}

/** A quantum gate's rails, one height per qubit. */
function fitRails(
	component: QuantumGateComponent | QuantumSpecialComponent,
	connections: readonly SchematicConnection[],
	byId: ReadonlyMap<string, SchematicComponent>,
	pending: ReadonlySet<string>
): void {
	const ports = definition(component).ports(component);
	const inputs = ports.filter((entry) => entry.nx < 0 && entry.ny === 0);
	const outputs = ports.filter((entry) => entry.nx > 0 && entry.ny === 0);
	const known = inputs.map(
		(input, index) =>
			arrival(component, input.id, connections, byId, pending) ?? arrival(component, outputs[index]!.id, connections, byId, pending)
	);
	const rails = fill(known, 18_000);
	if (rails === undefined) return;
	const order = rails.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
	for (let index = 1; index < order.length; index += 1) {
		const [upper, lower] = [order[index - 1]!, order[index]!];
		if (lower.value - upper.value < FIT_GAP * 1000) {
			throw new SchematicSyntaxError(
				`${component.id} cannot line up rails ${upper.index + 1} and ${lower.index + 1} with their wires: they arrive ${units(lower.value - upper.value)} units apart, and rails need at least ${FIT_GAP}. Move the wire on rail ${lower.index + 1} to y >= ${units(upper.value + FIT_GAP * 1000)}, or remove fit=wires.`,
				component.line,
				undefined,
				'geometry'
			);
		}
	}
	const centre = roundDiv(order[0]!.value + order.at(-1)!.value, 2);
	component.y = fromMilli(centre);
	component.rails = rails.map((value) => fromMilli(value - centre));
}

/** A block's left and right pins, each side in its declared order. */
function fitRows(
	component: IcComponent | DigitalComponent,
	connections: readonly SchematicConnection[],
	byId: ReadonlyMap<string, SchematicComponent>,
	pending: ReadonlySet<string>
): void {
	const ports = definition(component).ports(component);
	const pitch = component.kind === 'ic' ? 18_000 : 16_000;
	const sides = (['left', 'right'] as const).map((side) => {
		const terminals = ports.filter((entry) => entry.ny === 0 && (side === 'left' ? entry.nx < 0 : entry.nx > 0));
		const known = terminals.map((entry) => arrival(component, entry.id, connections, byId, pending));
		return { side, terminals, rows: fill(known, pitch) };
	});
	const wired = sides.flatMap((entry) => entry.rows ?? []);
	if (wired.length === 0) return;
	for (const { side, terminals, rows } of sides) {
		for (let index = 1; rows !== undefined && index < rows.length; index += 1) {
			const [upper, lower] = [rows[index - 1]!, rows[index]!];
			if (lower - upper >= FIT_GAP * 1000) continue;
			const [above, below] = [terminals[index - 1]!.id, terminals[index]!.id];
			throw new SchematicSyntaxError(
				lower <= upper
					? `${component.id} cannot line up ${below} with its wire: it arrives at y=${units(lower)}, ${lower === upper ? 'level with' : 'above'} ${above}'s at y=${units(upper)}, but ${below} sits below ${above} on ${component.id}'s ${side} side. Swap the wires, reorder the pins, or remove fit=wires.`
					: `${component.id} cannot line up ${below} with its wire: it arrives ${units(lower - upper)} units below ${above}'s, and pins need at least ${FIT_GAP}. Move the wire on ${below} to y >= ${units(upper + FIT_GAP * 1000)}, or remove fit=wires.`,
				component.line,
				undefined,
				'geometry'
			);
		}
	}
	const centre = roundDiv(Math.min(...wired) + Math.max(...wired), 2);
	let reach = 0;
	for (const value of wired) reach = Math.max(reach, Math.abs(value - centre));
	/* A pad of one pitch keeps the outermost pins off the corners, as the
	   unfitted spacing does; the body never shrinks below its usual height. */
	const height = Math.max(component.bodyHeight * 1000, 2 * (reach + pitch));
	const placed = sides.map(({ terminals, rows }) =>
		rows === undefined
			? terminals.map((_, index) => roundDiv((index + 1) * height * 2 - height * (terminals.length + 1), 2 * (terminals.length + 1)))
			: rows.map((value) => value - centre)
	);
	component.y = fromMilli(centre);
	component.bodyHeight = fromMilli(height);
	component.rows = { left: placed[0]!.map(fromMilli), right: placed[1]!.map(fromMilli) };
}

/**
 * Settle every `fit=wires` part against the wires validated for it.
 *
 * @param components - Placed components; fitted ones are updated in place.
 * @param connections - Validated connections with canonical terminal names.
 * @param report - Receives each part that cannot be fitted; fitting goes on.
 */
export function fitComponents(
	components: readonly SchematicComponent[],
	connections: readonly SchematicConnection[],
	report: (error: unknown) => void
): void {
	const fitted = components.filter(isFitted);
	if (fitted.length === 0) return;
	const byId = new Map(components.map((component) => [component.id, component]));
	const order = [...fitted].sort((a, b) => toMilli(a.x) - toMilli(b.x) || toMilli(a.y) - toMilli(b.y) || (a.id < b.id ? -1 : 1));
	const pending = new Set(order.map((component) => component.id));
	for (const component of order) {
		pending.delete(component.id);
		try {
			if (component.kind === 'ic' || 'bodyHeight' in component) fitRows(component as IcComponent | DigitalComponent, connections, byId, pending);
			else fitRails(component, connections, byId, pending);
		} catch (error) {
			report(error);
		}
	}
}
