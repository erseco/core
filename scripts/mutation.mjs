import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mutants = [
	{
		name: "a closed marker keeps its trace out of a compound path",
		file: "src/renderer.ts",
		from: "\t\tconst key = markerAttributes.includes('marker-')",
		to: "\t\tconst key = markerAttributes.includes('marker-') && false",
		tests: ["tests/renderer.test.ts", "tests/regressions.test.ts"]
	},
	{
		name: "a caller-supplied budget is enforced, not merely accepted",
		file: "src/limits.ts",
		from: "\t\tresolved[name] = limit;",
		to: "\t\tresolved[name] = resolved[name]!;",
		tests: ["tests/regressions.test.ts"]
	},
	{
		name: "a misspelled budget field fails instead of being ignored",
		file: "src/limits.ts",
		from: "\t\tif (!CONFIGURABLE_LIMITS.includes(name)) {",
		to: "\t\tif (false && CONFIGURABLE_LIMITS.includes(name)) {",
		tests: ["tests/regressions.test.ts"]
	},
	{
		name: "one budget governs the whole compilation",
		file: "src/compiler.ts",
		from: "\t\tlimits: resolveSchematicLimits(options.limits)",
		to: "\t\tlimits: options.limits",
		tests: ["tests/regressions.test.ts"]
	},
	{
		name: "open triangle interiors stay transparent",
		file: "src/renderer.ts",
		from: "d=\"M0 1 11 6 0 11Z\" fill=\"none\"",
		to: "d=\"M0 1 11 6 0 11Z\" fill=\"context-stroke\"",
		tests: ["tests/renderer.test.ts"]
	},
	{
		name: "an unconstrained axis inherits the first reference",
		file: "src/placement.ts",
		from: "\t\tlet position: IPoint = { x: seed.originX, y: seed.originY };",
		to: "\t\tlet position: IPoint = { x: 0, y: 0 };",
		tests: ["tests/placement.test.ts"]
	},
	{
		name: "a direction measures from the reference body, not its origin",
		file: "src/placement.ts",
		from: "\t\treturn { ...milliRect(componentRectangle(component)), originX: toMilli(component.x), originY: toMilli(component.y) };",
		to: "\t\treturn { minX: toMilli(component.x), maxX: toMilli(component.x), minY: toMilli(component.y), maxY: toMilli(component.y), originX: toMilli(component.x), originY: toMilli(component.y) };",
		tests: ["tests/placement.test.ts"]
	},
	{
		name: "the two axis gap defaults stay distinct",
		file: "src/placement.ts",
		from: "PLACEMENT_HORIZONTAL_GAP : PLACEMENT_VERTICAL_GAP) * 1000",
		to: "PLACEMENT_HORIZONTAL_GAP : PLACEMENT_HORIZONTAL_GAP) * 1000",
		tests: ["tests/placement.test.ts"]
	},
	{
		name: "the placement depth budget is enforced",
		file: "src/placement.ts",
		from: "\t\tif (chain > placementDepth) {",
		to: "\t\tif (false && chain > placementDepth) {",
		tests: ["tests/placement.test.ts"]
	},
	{
		name: "reported placements are ordered by source line",
		file: "src/placement.ts",
		from: "\treturn placements.sort((left, right) => left.line - right.line);",
		to: "\treturn placements.sort((left, right) => right.line - left.line);",
		tests: ["tests/placement.test.ts"]
	},
	{
		name: "a declaration waits for every reference it names",
		file: "src/placement.ts",
		from: "\t\t\tif (remaining === 0) ready.push(dependent);",
		to: "\t\t\tready.push(dependent);",
		tests: ["tests/placement.test.ts"]
	},
	{
		name: "a digest states the precision the SVG writer uses",
		file: "src/snapshot.ts",
		from: "\treturn value.toFixed(3);",
		to: "\treturn value.toFixed(2);",
		tests: ["tests/snapshot.test.ts"]
	},
	{
		name: "a digest reports the orientation a declaration stated",
		file: "src/snapshot.ts",
		from: "\tif ('orientation' in component && component.orientation !== undefined) {",
		to: "\tif ('orientation' in component && component.orientation === undefined) {",
		tests: ["tests/snapshot.test.ts"]
	},
	{
		name: "recovery reads a curve from the path that was drawn",
		file: "src/decompile.ts",
		from: "\tif (/\\s[HV]\\s/.test(path)) return 'ortho';",
		to: "\tif (false) return 'ortho';",
		tests: ["tests/decompile.test.ts"]
	},
	{
		name: "recovery writes a CSS colour without the token sigil",
		file: "src/decompile.ts",
		from: "\tif (color.kind === 'css') return color.value;",
		to: "\tif (color.kind === 'css') return `#${color.value}`;",
		tests: ["tests/decompile.test.ts"]
	},
	{
		name: "recovery rejects a colour token the parser does not define",
		file: "src/decompile.ts",
		from: "\treturn (SEMANTIC_COLORS as readonly string[]).includes(value);",
		to: "\treturn true;",
		tests: ["tests/decompile.test.ts"]
	},
	{
		name: "recovery skips a group missing what full mode always writes",
		file: "src/decompile.ts",
		from: "\t\tif (id === undefined || kind === undefined || label === undefined || line === undefined) {",
		to: "\t\tif (id === undefined || kind === undefined) {",
		tests: ["tests/decompile.test.ts"]
	},
	{
		name: "the SVG writer refuses a chunk that overruns the budget",
		file: "src/renderer.ts",
		from: "\t\tif (read < chunk.length || written > remaining) throw this.#overBudget();",
		to: "\t\tif (written > remaining) throw this.#overBudget();",
		tests: ["tests/byte-writer.test.ts"]
	},
	{
		name: "a rejected SVG append commits nothing",
		file: "src/renderer.ts",
		from: "\t\tif (read < chunk.length || written > remaining) throw this.#overBudget();\n\t\tthis.#at += written;",
		to: "\t\tthis.#at += written;\n\t\tif (read < chunk.length || written > remaining) throw this.#overBudget();",
		tests: ["tests/byte-writer.test.ts"]
	},
	{
		name: "the SVG writer reports the size it actually wrote",
		file: "src/renderer.ts",
		from: "\treturn this.#at;",
		to: "\treturn this.#buffer.length;",
		tests: ["tests/byte-writer.test.ts", "tests/compiler.test.ts"]
	},
	{
		name: "a branch joins the net at the end wired above it",
		file: "src/parser.ts",
		from: "connection.trunk = fromWired ? 'from' : 'to';",
		to: "connection.trunk = 'from';",
		tests: ["tests/trunk.test.ts"]
	},
	{
		name: "an instance parameter overrides the default",
		file: "src/parser.ts",
		from: "const value = supplied.get(parameter) ?? fallback;",
		to: "const value = fallback ?? supplied.get(parameter);",
		tests: ["tests/subcircuit.test.ts"]
	},
	{
		name: "a subcircuit cannot contain itself",
		file: "src/parser.ts",
		from: "if (stack.includes(kind!)) {",
		to: "if (false) {",
		tests: ["tests/subcircuit.test.ts"]
	},
	{
		name: "an exposed terminal resolves through every level of nesting",
		file: "src/parser.ts",
		from: "while (instances.has(id)) {",
		to: "if (instances.has(id)) {",
		tests: ["tests/subcircuit.test.ts"]
	},
	{
		name: "shared terminals must unify inferred nets",
		file: "src/parser.ts",
		from: "if (owner === undefined) terminals.set(key, index);\n\t\t\telse union(index, owner);",
		to: "if (owner === undefined) terminals.set(key, index);\n\t\t\telse union(index, index);",
		tests: ["tests/topology.test.ts"]
	},
	{
		name: "equal explicit net names must unify disconnected terminals",
		file: "src/parser.ts",
		from: "if (owner === undefined) names.set(connection.net, index);\n\t\t\telse union(index, owner);",
		to: "if (owner === undefined) names.set(connection.net, index);\n\t\t\telse union(index, index);",
		tests: ["tests/topology.test.ts"]
	},
	{
		name: "connector labels remain routing obstacles",
		file: "src/layout.ts",
		from: "label: connection.label === undefined ? undefined : (route) => labelRectAt(connection, midpoint(route))",
		to: "label: undefined",
		tests: ["tests/layout.test.ts"]
	},
	{
		name: "port aliases resolve to one canonical terminal",
		file: "src/parser.ts",
		from: "connection.from.port = canonicalName(byId.get(connection.from.componentId)!, connection.from.port)!;",
		to: "",
		tests: ["tests/regressions.test.ts"]
	},
	{
		name: "vertically touching component bounds are not overlaps",
		file: "src/geom.ts",
		from: "left.maxY > right.minY",
		to: "left.maxY >= right.minY",
		tests: ["tests/geom.test.ts", "tests/layout.test.ts"]
	},
	{
		name: "a family set is derived from the registry it classifies",
		file: "src/layout.ts",
		from: "const UML = new Set<string>(UML_COMPONENT_KINDS);",
		to: "const UML = new Set<string>();",
		tests: ["tests/uml.test.ts", "tests/layout.test.ts"]
	},
	{
		name: "a bridge never bulges into a neighbouring wire",
		file: "src/layout.ts",
		from: "limit = Math.min(limit, Math.floor((x - run.x) / 2));",
		to: "limit = Math.min(limit, radius);",
		tests: ["tests/layout.test.ts"]
	},
	{
		name: "pin stubs of separate nets that touch are named, not routed",
		file: "src/layout.ts",
		from: "if (segmentContact(stub.a, stub.b, other.a, other.b) !== undefined) {",
		to: "if (false) {",
		tests: ["tests/layout.test.ts", "tests/regressions.test.ts"]
	},
	{
		name: "a drawn wire may not pass through a foreign terminal",
		file: "src/layout.ts",
		from: "if (segmentContact(chords[step - 1]!, chords[step]!, at, at) === undefined) continue;",
		to: "continue;",
		tests: ["tests/layout.test.ts"]
	},
	{
		name: "a pin exit through its own text turns only beyond it",
		file: "src/layout.ts",
		from: "if (placed.normal.y < 0 && rect.minY < escape.y && rect.maxY > escape.y - clearance) escape = { x: escape.x, y: rect.minY };",
		to: "",
		tests: ["tests/regressions.test.ts", "tests/layout.test.ts"]
	},
	{
		name: "congestion cells are reported in a stable order",
		file: "src/layout.ts",
		from: "congestion: [...cells.values()].sort((left, right) => left.x - right.x || left.y - right.y)",
		to: "congestion: [...cells.values()].reverse()",
		tests: ["tests/regressions.test.ts"]
	},
	{
		name: "a contested location costs every net, touching or not",
		file: "src/route.ts",
		from: "let cost = g + length * (soft === 2 ? 2 : 1) + history;",
		to: "let cost = g + length * (soft === 2 ? 2 : 1);",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "no shortcut retakes a priced track",
		file: "src/route.ts",
		from: "if (this.#history.size > 0) return undefined;",
		to: "",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "a priced path is compared with the whole canvas",
		file: "src/route.ts",
		from: "if (wide.cost < found.cost) found = wide;",
		to: "if (false) found = wide;",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "routing order is geometric, not declaration order",
		file: "src/route.ts",
		from: "\t\t\t\tleft.key[0] - right.key[0] ||\n\t\t\t\tleft.key[1] - right.key[1] ||\n\t\t\t\tleft.key[2] - right.key[2] ||\n\t\t\t\tleft.key[3] - right.key[3] ||\n",
		to: "",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "a short detour beats an avoidable bridge",
		file: "src/route.ts",
		from: "if (better !== undefined && better.crossings < found.crossings) return better.path;",
		to: "if (false) return better.path;",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "a tree never meets four ways",
		file: "src/route.ts",
		from: "if (degree < 3 && !crowded) startCells.push(cell);",
		to: "if (!crowded) startCells.push(cell);",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "a junction is held two pitches off the pins",
		file: "src/route.ts",
		from: "Math.abs(pin.x - x) + Math.abs(pin.y - y) < 2 * PITCH",
		to: "Math.abs(pin.x - x) + Math.abs(pin.y - y) < 0",
		tests: ["tests/trunk.test.ts"]
	},
	{
		name: "a stub through a third body is reported",
		file: "src/route.ts",
		from: "if (blocked >= 0) return fail(blocked, 'unroutable', 0);",
		to: "",
		tests: ["tests/route.test.ts", "tests/layout.test.ts"]
	},
	{
		name: "text holding an escape point cannot wall it in",
		file: "src/route.ts",
		from: "\t\t\t\tif (!holdsEscape(obstacle.rect)) block(obstacle.rect);",
		to: "\t\t\t\tblock(obstacle.rect);",
		tests: ["tests/regressions.test.ts", "tests/layout.test.ts"]
	},
	{
		name: "torn-up copper no longer occupies the canvas",
		file: "src/route.ts",
		from: "return this.#copper.query(rect).filter((piece) => piece.dead !== true);",
		to: "return this.#copper.query(rect);",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "a wire ending on another net is a contact",
		file: "src/route.ts",
		from: "if (along >= low && along <= high) flag(piece, other, end);",
		to: "",
		tests: ["tests/route.test.ts"]
	},
	{
		name: "the router heap prefers the deeper of two equal estimates",
		file: "src/route.ts",
		from: "return f1 !== f2 ? f1 < f2 : g1 !== g2 ? g1 > g2 : s1 < s2;",
		to: "return f1 !== f2 ? f1 < f2 : s1 < s2;",
		tests: ["tests/route.test.ts", "tests/regressions.test.ts", "tests/trunk.test.ts", "tests/layout.test.ts"]
	},
	{
		name: "rounding is symmetric about zero",
		file: "src/geom.ts",
		from: "const rounded = Math.floor(quotient + 0.5);\n\treturn numerator < 0 ? -rounded : rounded;",
		to: "return Math.round(numerator / denominator);",
		tests: ["tests/geom.test.ts"]
	},
	{
		name: "orientation falls back to exact BigInt products",
		file: "src/geom.ts",
		from: "const limit = 67_108_864;",
		to: "const limit = Number.POSITIVE_INFINITY;",
		tests: ["tests/geom.test.ts"]
	},
	{
		name: "formatted decimals carry no trailing zeros",
		file: "src/geom.ts",
		from: "while (digits.endsWith('0')) digits = digits.slice(0, -1);",
		to: "",
		tests: ["tests/geom.test.ts"]
	},
	{
		name: "a fourth decimal rounds the milli-unit",
		file: "src/geom.ts",
		from: "if (fraction.length > 3 && fraction.charCodeAt(3) >= 53) value += 1;",
		to: "",
		tests: ["tests/geom.test.ts"]
	},
	{
		name: "an unknown endpoint is reported at its token",
		file: "src/parser.ts",
		from: "checkEndpoint(connection.from, byId, connection.line, fromId, fromPort);",
		to: "checkEndpoint(connection.from, byId, connection.line, undefined, undefined);",
		tests: ["tests/diagnose.test.ts"]
	},
	{
		name: "a failed component is not blamed again by its wires",
		file: "src/parser.ts",
		from: "if (poisoned.has(connection.from.componentId) || poisoned.has(connection.to.componentId)) continue;",
		to: "",
		tests: ["tests/diagnose.test.ts"]
	},
	{
		name: "diagnostics are listed in source order",
		file: "src/parser.ts",
		from: "return reporter.diagnostics.sort((left, right) => left.line! - right.line!);",
		to: "return reporter.diagnostics;",
		tests: ["tests/diagnose.test.ts"]
	},
	{
		name: "a substituted line carries no column",
		file: "src/parser.ts",
		from: "if (source.shifted === true) return undefined;",
		to: "",
		tests: ["tests/diagnose.test.ts"]
	},
	{
		name: "copied coordinates are offset by the instance position",
		file: "src/parser.ts",
		from: "x: fromMilli(parseMilli(syntax.x.text) + dx)",
		to: "x: fromMilli(parseMilli(syntax.x.text))",
		tests: ["tests/subcircuit.test.ts"]
	},
	{
		name: "nested instance offsets compose",
		file: "src/parser.ts",
		from: "dx + parseMilli(instance[3]!), dy + parseMilli(instance[4]!)",
		to: "parseMilli(instance[3]!), parseMilli(instance[4]!)",
		tests: ["tests/subcircuit.test.ts"]
	},
	{
		name: "expansion is held to the source character budget",
		file: "src/parser.ts",
		from: "if (characters > budget) {",
		to: "if (false) {",
		tests: ["tests/subcircuit.test.ts"]
	},
	{
		name: "an alias names the terminal drawn at its point",
		file: "src/symbols/index.ts",
		from: "return ports.find((entry) => entry.x === local.x && entry.y === local.y)?.id ?? local.id;",
		to: "return local.id;",
		tests: ["tests/ports.test.ts"]
	},
	{
		name: "reset accepts the numbered spellings of its one track",
		file: "src/symbols/quantum.ts",
		from: "if (component.kind === 'reset' && /^(in|out)1$/.test(name)) name = name.slice(0, -1);",
		to: "",
		tests: ["tests/ports.test.ts"]
	},
	{
		name: "orientation turns clockwise",
		file: "src/symbols/index.ts",
		from: "{ right: 0, down: 1, left: 2, up: 3 }",
		to: "{ right: 0, down: 3, left: 2, up: 1 }",
		tests: ["tests/ports.test.ts", "tests/primitives.test.ts"]
	},
	{
		name: "a relation is read only where the last one ended",
		file: "src/syntax.ts",
		from: "(?:\\\\s+by\\\\s+(${DECIMAL}))?(?:\\\\s+|$)`, 'yd');",
		to: "(?:\\\\s+by\\\\s+(${DECIMAL}))?(?:\\\\s+|$)`, 'gd');",
		tests: ["tests/syntax.test.ts"]
	},
	{
		name: "a relative declaration needs a tail after its relations",
		file: "src/syntax.ts",
		from: "if (clause.relations.length > 0 && clause.tail < text.length) {",
		to: "if (clause.relations.length > 0) {",
		tests: ["tests/syntax.test.ts"]
	},
	{
		name: "a token reports the columns it sits at",
		file: "src/syntax.ts",
		from: "const [start, end] = match.indices![group]!;\n\treturn { text: match[group]!, start, end };",
		to: "return { text: match[group]!, start: 0, end: match[group]!.length };",
		tests: ["tests/diagnose.test.ts"]
	},
	{
		name: "a wire sets off along its pin's axis",
		file: "src/route.ts",
		from: "const heading = mode === 'point' ? axes[0] : 0;",
		to: "const heading = 0;",
		tests: ["tests/layout.test.ts", "tests/regressions.test.ts", "tests/trunk.test.ts"]
	},
	{
		name: "a pin is never entered from behind, along its own stub",
		file: "src/route.ts",
		from: "if (along[index] === to) continue;",
		to: "continue;",
		tests: ["tests/layout.test.ts", "tests/route.test.ts", "tests/regressions.test.ts"]
	},
	{
		name: "a free pin is never passed through",
		file: "src/layout.ts",
		from: "\t\t\tif (wired.has(`${component.id}.${port.id}`)) continue;",
		to: "\t\t\tcontinue;",
		tests: ["tests/regressions.test.ts"]
	},
	{
		name: "a wire runs inside its own component's clearance only at a price",
		file: "src/route.ts",
		from: "let cost = g + length * (soft === 2 ? 2 : 1) + history;",
		to: "let cost = g + length + history;",
		tests: ["tests/regressions.test.ts", "tests/layout.test.ts", "tests/trunk.test.ts"]
	}
];

const sandbox = await mkdtemp(join(tmpdir(), 'schemd-mutation-'));
try {
	for (const path of ['src', 'tests']) await cp(join(root, path), join(sandbox, path), { recursive: true });
	for (const path of ['package.json', 'tsconfig.json', 'vitest.config.ts']) {
		await cp(join(root, path), join(sandbox, path));
	}
	await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
	const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
	const survivors = [];

	for (const mutant of mutants) {
		const path = join(sandbox, mutant.file);
		const original = await readFile(join(root, mutant.file), 'utf8');
		const first = original.indexOf(mutant.from);
		if (first < 0 || original.indexOf(mutant.from, first + mutant.from.length) >= 0) {
			throw new Error(`Mutation target must occur exactly once: ${mutant.name}`);
		}
		await writeFile(path, original.replace(mutant.from, mutant.to));
		const result = spawnSync(process.execPath, [vitest, 'run', ...mutant.tests], {
			cwd: sandbox,
			env: { ...process.env, FORCE_COLOR: '0' },
			encoding: 'utf8',
			timeout: 45_000
		});
		await writeFile(path, original);
		if (result.error !== undefined && result.error.code !== 'ETIMEDOUT') throw result.error;
		if (result.status === 0) {
			survivors.push({ mutant, output: `${result.stdout}${result.stderr}` });
			console.error(`SURVIVED  ${mutant.name}`);
		} else {
			console.log(`KILLED    ${mutant.name}`);
		}
	}

	if (survivors.length > 0) {
		for (const { mutant, output } of survivors) {
			console.error(`\n--- ${mutant.name} ---\n${output.trim()}`);
		}
		process.exitCode = 1;
	} else {
		console.log(`\nMutation score: 100% (${mutants.length}/${mutants.length} killed)`);
	}
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
