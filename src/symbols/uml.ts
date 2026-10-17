/**
 * UML symbols: structural and behavioural nodes. None rotate.
 *
 * @module
 */
import { toMilli } from '../geom.js';
import { mathLabelTextWidth, renderMathLabelTspans } from '../math-label.js';
import {
	SchematicSyntaxError,
	type UmlActorComponent,
	type UmlClassComponent,
	type UmlComponent,
	type UmlPseudostateComponent,
	type UmlSizedComponent,
	type UmlStateComponent
} from '../types.js';
import { enumOption, only, TEXT_PAINT, u, type CommonFields, type KindDef, type LocalPort } from './common.js';

const MAX_ROWS = 64;
const MAX_ROW_LENGTH = 256;
const ROW = 16;

function rows(value: string | undefined, name: string, line: number): readonly string[] {
	if (value === undefined || value.trim() === '') return [];
	const list = value.split(';').map((row) => row.trim());
	if (list.length > MAX_ROWS) throw new SchematicSyntaxError(`${name} supports at most ${MAX_ROWS} rows.`, line);
	for (const row of list) {
		if (row === '' || row.length > MAX_ROW_LENGTH) throw new SchematicSyntaxError(`${name} rows must contain 1 through ${MAX_ROW_LENGTH} characters.`, line);
	}
	return list;
}

function dimension(value: string | undefined, fallback: number, name: string, line: number): number {
	if (value === undefined) return fallback;
	if (!/^\d+(?:\.\d+)?$/.test(value)) throw new SchematicSyntaxError(`${name} must be a finite number from 24 through 2048.`, line);
	const parsed = Number(value);
	if (parsed < 24 || parsed > 2048) throw new SchematicSyntaxError(`${name} must be a finite number from 24 through 2048.`, line);
	return parsed;
}

function widest(list: readonly string[]): number {
	let value = 0;
	for (const row of list) value = Math.max(value, mathLabelTextWidth(row, 8));
	return value;
}

const CLASS_KINDS = new Set(['class', 'interface', 'enumeration', 'datatype', 'object']);
const SIZED_KINDS = new Set([
	'usecase', 'lifeline', 'note', 'package', 'component', 'artifact', 'node', 'device', 'execution',
	'system', 'action', 'object-node', 'partition', 'activation', 'fragment', 'interaction', 'region'
]);
const SMALL: Readonly<Record<string, readonly [number, number]>> = {
	actor: [24, 50], decision: [18, 18], merge: [18, 18], choice: [18, 18], fork: [38, 5], join: [38, 5],
	'send-signal': [22, 15], 'receive-signal': [22, 15]
};

/** Body half-extents in milli-units. */
function half(component: UmlComponent): readonly [number, number] {
	if ('bodyWidth' in component) return [toMilli(component.bodyWidth / 2), toMilli(component.bodyHeight / 2)];
	const small = SMALL[component.kind];
	return small === undefined ? [12_000, 12_000] : [small[0] * 1000, small[1] * 1000];
}

function sides(component: UmlComponent): LocalPort[] {
	const [w, h] = half(component);
	return [
		{ id: 'left', x: -w, y: 0, nx: -1, ny: 0 },
		{ id: 'right', x: w, y: 0, nx: 1, ny: 0 },
		{ id: 'top', x: 0, y: -h, nx: 0, ny: -1 },
		{ id: 'bottom', x: 0, y: h, nx: 0, ny: 1 }
	];
}

function row(value: string, x: number, y: number): string {
	return `<text class="schematic-uml-text schematic-uml-row" ${TEXT_PAINT} x="${u(x)}" y="${u(y)}" font-size="12">${renderMathLabelTspans(value)}</text>`;
}

function label(component: UmlComponent, y = '4', size = 12): string {
	return `<text class="schematic-uml-text" ${TEXT_PAINT} x="0" y="${y}" text-anchor="middle" font-size="${size}">${renderMathLabelTspans(component.label)}</text>`;
}

function classShape(component: UmlClassComponent, paint: string): string {
	const left = -component.bodyWidth / 2;
	const top = -component.bodyHeight / 2;
	const header = 36 + (component.stereotype === undefined ? 0 : 14);
	const attributeSeparator = top + header;
	const operationSeparator = attributeSeparator + Math.max(24, component.attributes.length * ROW + 8);
	const stereotype =
		component.stereotype === undefined
			? ''
			: `<text class="schematic-uml-text schematic-uml-stereotype" ${TEXT_PAINT} x="0" y="${u(top + 13)}" text-anchor="middle" font-size="11">«${renderMathLabelTspans(component.stereotype)}»</text>`;
	const nameY = top + (component.stereotype === undefined ? 23 : 32);
	const attributes = component.attributes.map((value, index) => row(value, left + 8, attributeSeparator + 17 + index * ROW)).join('');
	const operations = component.operations.map((value, index) => row(value, left + 8, operationSeparator + 17 + index * ROW)).join('');
	return `<rect ${paint} x="${u(left)}" y="${u(top)}" width="${u(component.bodyWidth)}" height="${u(component.bodyHeight)}" rx="2" /><path ${paint} d="M ${u(left)} ${u(attributeSeparator)} H ${u(-left)} M ${u(left)} ${u(operationSeparator)} H ${u(-left)}" />${stereotype}<text class="schematic-uml-text" ${TEXT_PAINT} x="0" y="${u(nameY)}" text-anchor="middle" font-size="13" font-weight="600">${renderMathLabelTspans(component.label)}</text>${attributes}${operations}`;
}

function stateShape(component: UmlStateComponent, paint: string): string {
	const left = -component.bodyWidth / 2;
	const top = -component.bodyHeight / 2;
	const separator = top + 32;
	const list = component.details.map((value, index) => row(value, left + 8, separator + 17 + index * ROW)).join('');
	return `<rect ${paint} x="${u(left)}" y="${u(top)}" width="${u(component.bodyWidth)}" height="${u(component.bodyHeight)}" rx="10" />${component.details.length === 0 ? '' : `<path ${paint} d="M ${u(left)} ${u(separator)} H ${u(-left)}" />`}<text class="schematic-uml-text" ${TEXT_PAINT} x="0" y="${u(top + 21)}" text-anchor="middle" font-size="13" font-weight="600">${renderMathLabelTspans(component.label)}</text>${list}`;
}

function sizedShape(component: UmlSizedComponent, paint: string): string {
	const left = -component.bodyWidth / 2;
	const top = -component.bodyHeight / 2;
	const right = -left;
	const bottom = -top;
	const box = (extra = '', rx: number | undefined = undefined) =>
		`<rect ${paint}${extra} x="${u(left)}" y="${u(top)}" width="${u(component.bodyWidth)}" height="${u(component.bodyHeight)}"${rx === undefined ? '' : ` rx="${rx}"`} />`;
	switch (component.kind) {
		case 'usecase':
			return `<ellipse ${paint} cx="0" cy="0" rx="${u(component.bodyWidth / 2)}" ry="${u(component.bodyHeight / 2)}" />${label(component, '4', 13)}`;
		case 'lifeline':
			return `<rect ${paint} x="${u(left)}" y="${u(top)}" width="${u(component.bodyWidth)}" height="32" rx="2" />${label(component, u(top + 21))}<path ${paint} stroke-dasharray="6 5" d="M 0 ${u(top + 32)} V ${u(bottom)}" />`;
		case 'note':
			return `<path ${paint} d="M ${u(left)} ${u(top)} H ${u(right - 14)} L ${u(right)} ${u(top + 14)} V ${u(bottom)} H ${u(left)} Z M ${u(right - 14)} ${u(top)} V ${u(top + 14)} H ${u(right)}" />${label(component)}`;
		case 'package':
			return `<path ${paint} d="M ${u(left)} ${u(top + 12)} V ${u(bottom)} H ${u(right)} V ${u(top)} H ${u(left + Math.min(54, component.bodyWidth / 2))} L ${u(left + Math.min(64, component.bodyWidth / 2 + 10))} ${u(top + 12)} Z" />${label(component, '4', 13)}`;
		case 'activation':
			return box();
		case 'fragment':
		case 'interaction':
			return `${box()}<path ${paint} d="M ${u(left)} ${u(top + 20)} H ${u(left + 58)} L ${u(left + 68)} ${u(top + 10)} V ${u(top)}" /><text class="schematic-uml-text" ${TEXT_PAINT} x="${u(left + 6)}" y="${u(top + 14)}" font-size="11">${component.kind === 'interaction' ? 'ref' : 'alt'}</text>${label(component)}`;
		default: {
			const icon =
				component.kind === 'component'
					? `<path ${paint} d="M ${u(right - 22)} ${u(top + 10)} h 14 v 10 h -14 z M ${u(right - 22)} ${u(top + 25)} h 14 v 10 h -14 z" />`
					: component.kind === 'artifact'
						? `<path ${paint} d="M ${u(right - 16)} ${u(top)} v 16 h 16" />`
						: component.kind === 'node' || component.kind === 'device' || component.kind === 'execution'
							? `<path ${paint} d="M ${u(left)} ${u(top + 10)} l 12 -10 h ${u(component.bodyWidth)} l -12 10 M ${u(right)} ${u(top)} v ${u(component.bodyHeight - 10)} l -12 10" />`
							: component.kind === 'partition'
								? `<path ${paint} d="M ${u(left + 28)} ${u(top)} V ${u(bottom)}" />`
								: '';
			return `${box(component.kind === 'region' ? ' stroke-dasharray="6 4"' : '', component.kind === 'action' ? 10 : 1)}${icon}${label(component)}`;
		}
	}
}

function smallShape(component: UmlActorComponent | UmlPseudostateComponent, paint: string, nodePaint: string): string {
	switch (component.kind) {
		case 'actor':
			return `<circle ${paint} cx="0" cy="-28" r="9" /><path ${paint} d="M 0 -19 V 12 M -20 -5 H 20 M 0 12 L -17 37 M 0 12 L 17 37" />${label(component, '49')}`;
		case 'provided-interface':
			return `<circle ${paint} cx="0" cy="0" r="10" />`;
		case 'required-interface':
			return `<path ${paint} d="M 0 -10 A 10 10 0 0 0 0 10" />`;
		case 'component-port':
			return `<rect ${paint} x="-7" y="-7" width="14" height="14" />`;
		case 'decision':
		case 'merge':
		case 'choice':
			return `<path ${paint} d="M 0 -17 L 17 0 0 17 -17 0 Z" />`;
		case 'fork':
		case 'join':
			return `<rect ${nodePaint} x="-38" y="-4" width="76" height="8" rx="1" />`;
		case 'activity-final':
		case 'final':
			return `<circle ${paint} cx="0" cy="0" r="11" /><circle ${nodePaint} cx="0" cy="0" r="6" />`;
		case 'flow-final':
			return `<circle ${paint} cx="0" cy="0" r="11" /><path ${paint} d="M -7 -7 L 7 7 M 7 -7 L -7 7" />`;
		case 'send-signal':
			return `<path ${paint} d="M -21 -14 H 5 L 21 0 5 14 H -21 Z" />`;
		case 'receive-signal':
			return `<path ${paint} d="M -21 -14 H 21 L 5 0 21 14 H -21 Z" />`;
		case 'destruction':
			return `<path ${paint} d="M -10 -10 L 10 10 M 10 -10 L -10 10" />`;
		case 'gate':
		case 'found':
		case 'lost':
			return `<circle ${component.kind === 'lost' ? paint : nodePaint} cx="0" cy="0" r="5" />`;
		case 'state-junction':
			return `<circle ${nodePaint} cx="0" cy="0" r="7" />`;
		case 'history':
			return `<circle ${paint} cx="0" cy="0" r="11" /><text class="schematic-uml-text" ${TEXT_PAINT} x="0" y="4" text-anchor="middle" font-size="11">H${component.variant === 'deep' ? '*' : ''}</text>`;
		case 'entry':
		case 'exit':
			return `<circle ${paint} cx="0" cy="0" r="10" />${component.kind === 'exit' ? `<path ${paint} d="M -6 -6 L 6 6 M 6 -6 L -6 6" />` : ''}`;
		case 'terminate':
			return `<path ${paint} d="M -9 -9 L 9 9 M 9 -9 L -9 9" />`;
		case 'initial':
			return `<circle ${nodePaint} cx="0" cy="0" r="10" />`;
	}
}

const uml: KindDef<UmlComponent> = {
	parse(kind, common: CommonFields, options, line): UmlComponent {
		if (CLASS_KINDS.has(kind)) {
			only(options, ['attributes', 'operations', 'stereotype', 'width'], line);
			const attributes = rows(options.get('attributes'), 'attributes', line);
			const operations = rows(options.get('operations'), 'operations', line);
			const stereotype = options.get('stereotype') ?? (kind === 'interface' || kind === 'enumeration' || kind === 'datatype' ? kind : undefined);
			if (stereotype !== undefined && (stereotype === '' || stereotype.length > 128)) {
				throw new SchematicSyntaxError('stereotype must contain 1 through 128 characters.', line);
			}
			const calculated = Math.max(120, widest([common.label, stereotype ?? '', ...attributes, ...operations]) + 24);
			const component: UmlClassComponent = {
				kind: kind as UmlClassComponent['kind'],
				...common,
				attributes,
				operations,
				bodyWidth: Math.max(calculated, dimension(options.get('width'), calculated, 'width', line)),
				bodyHeight: 36 + Math.max(24, attributes.length * ROW + 8) + Math.max(24, operations.length * ROW + 8) + (stereotype === undefined ? 0 : 14)
			};
			if (stereotype !== undefined) component.stereotype = stereotype;
			return component;
		}
		if (kind === 'state') {
			only(options, ['details', 'width'], line);
			const details = rows(options.get('details'), 'details', line);
			const calculated = Math.max(112, widest([common.label, ...details]) + 28);
			return {
				kind: 'state',
				...common,
				details,
				bodyWidth: Math.max(calculated, dimension(options.get('width'), calculated, 'width', line)),
				bodyHeight: 40 + details.length * ROW
			};
		}
		if (kind === 'history') {
			only(options, ['type'], line);
			return { kind: 'history', ...common, variant: enumOption(options.get('type'), 'shallow', ['shallow', 'deep'] as const, 'type', line) };
		}
		if (SIZED_KINDS.has(kind)) {
			only(options, ['width', 'height'], line);
			const defaultWidth = Math.max(kind === 'usecase' ? 112 : 96, mathLabelTextWidth(common.label, 8) + 28);
			const defaultHeight = kind === 'lifeline' ? 180 : kind === 'activation' ? 96 : kind === 'usecase' ? 56 : 64;
			return {
				kind: kind as UmlSizedComponent['kind'],
				...common,
				bodyWidth: Math.max(defaultWidth, dimension(options.get('width'), defaultWidth, 'width', line)),
				bodyHeight: Math.max(defaultHeight, dimension(options.get('height'), defaultHeight, 'height', line))
			};
		}
		only(options, [], line);
		return { kind: kind as UmlPseudostateComponent['kind'], ...common } as UmlComponent;
	},
	extents: half,
	ports: sides,
	resolve(component, name) {
		const ports = sides(component);
		if (name === 'in') return { ...ports[0]!, id: 'in' };
		if (name === 'out') return { ...ports[1]!, id: 'out' };
		const exact = ports.find((entry) => entry.id === name);
		if (exact !== undefined || component.kind !== 'lifeline') return exact;
		const match = /^(left|right)(\d+)$/.exec(name);
		if (match === null) return undefined;
		const offset = Number(match[2]);
		if (offset > component.bodyHeight) return undefined;
		const [w, h] = half(component);
		return { id: name, x: match[1] === 'left' ? -w : w, y: -h + offset * 1000, nx: match[1] === 'left' ? -1 : 1, ny: 0 };
	},
	draw(component, paint, nodePaint) {
		if (CLASS_KINDS.has(component.kind)) return classShape(component as UmlClassComponent, paint);
		if (component.kind === 'state') return stateShape(component, paint);
		if (SIZED_KINDS.has(component.kind)) return sizedShape(component as UmlSizedComponent, paint);
		return smallShape(component as UmlActorComponent | UmlPseudostateComponent, paint, nodePaint);
	}
};

export const UML_KINDS: Readonly<Record<string, KindDef<never>>> = Object.fromEntries(
	[
		...CLASS_KINDS, 'state', 'history', ...SIZED_KINDS, 'actor', 'provided-interface', 'required-interface',
		'component-port', 'decision', 'merge', 'fork', 'join', 'activity-final', 'flow-final', 'send-signal',
		'receive-signal', 'destruction', 'gate', 'found', 'lost', 'choice', 'state-junction', 'entry', 'exit',
		'terminate', 'initial', 'final'
	].map((kind) => [kind, uml])
) as unknown as Readonly<Record<string, KindDef<never>>>;
