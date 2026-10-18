/**
 * Mutation fuzzer for the compiler's public contract.
 *
 * `tests/fuzz.test.ts` generates well-formed random documents and checks the
 * drawing. This starts from real documents instead and breaks them the way an
 * editor does mid-keystroke — characters dropped, lines duplicated or swapped,
 * numbers pushed to extremes, identifiers renamed, hostile Unicode inserted —
 * then checks every result against the promises the API makes:
 *
 *   1. `compileSchematic` returns, or throws a `SchematicSyntaxError`; nothing
 *      else escapes, and no case runs past the time ceiling.
 *   2. `diagnoseSchematic` never throws, and every diagnostic it returns has a
 *      known code, a line inside the document, and a column range inside that
 *      line, in source order.
 *   3. The two agree: a document compiles exactly when it has no diagnostics,
 *      and a thrown error's line is among the diagnosed lines.
 *   4. A compiled document is deterministic, its SVG is balanced markup with
 *      no `NaN`, `Infinity` or `undefined` in it, its source map points at
 *      real lines, and the netlist builds and verifies without throwing.
 *
 *   node scripts/fuzz.mjs [cases=20000] [seed=1] [seedDir]
 *
 * `seedDir` adds `{ fence, source }` JSON documents to the built-in seeds. A
 * failure prints the seed and case number, and writes the offending document
 * to `fuzz-failure-<case>.json`, so it reproduces exactly.
 *
 * @module
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
	buildNetlist,
	compileSchematic,
	diagnoseSchematic,
	parseSchematicFence,
	verifyNetlist
} from '../dist/index.js';
import { SchematicSyntaxError, SCHEMATIC_DIAGNOSTIC_CODES } from '../dist/types.js';

const CASES = Number(process.argv[2] ?? 20_000);
const SEED = Number(process.argv[3] ?? 1);
const SEED_DIR = process.argv[4];
const CEILING_MS = 2_000;

/** Mulberry32, as in `scripts/corpus.mjs`: a failure must replay exactly. */
function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BUILT_IN_SEEDS = [
	{
		fence: 'schemd bounds="900x560" title="Relative placement"',
		source: `source:VSUP "V_{sup}" at (90, 150) #blue [type=voltage-dc]
protection:FU "500 mA" right-of VSUP by 150 #amber [type=fuse]
junction:RAIL "rail" right-of FU by 150 #cyan
capacitor:CR "47 \\mu F" below RAIL by 110 #cyan [type=polarized orientation=down]
port:VOUT "V_{out}" right-of RAIL by 150 #emerald
ground:GR "0 V" below FU by 190 aligned-x with FU #slate

VSUP.positive -> FU.in #blue [ortho]
FU.out -> RAIL.node #amber [ortho]
RAIL.node -> CR.in #cyan [ortho]
RAIL.node -> VOUT.in #emerald [ortho marker-end=arrow]
CR.out -> GR.in #cyan [ortho]
VSUP.negative -> GR.in #slate [ortho]`
	},
	{
		fence: 'schemd bounds="980x540" title="Named-pin charger"',
		source: `port:USB "VBUS" at (90, 190) #blue
port:CE "charge enable" at (90, 320) #amber
ic:U5 "CHG" at (470, 260) #cyan [left="IN,CE,ILIM" right="BAT,STAT,TS" bottom="GND"]
source:CELL "Li-ion" at (870, 190) #emerald [type=battery orientation=down]
ground:CGND "0 V" at (470, 450) #slate

USB.out -> U5.IN #blue [ortho]
CE.out -> U5.CE #amber [ortho]
U5.BAT -> CELL.positive #emerald [ortho marker-end=arrow]
U5.GND -> CGND.in #slate [ortho]`
	},
	{
		fence: 'schemd bounds="760x440" title="Gate"',
		source: `port:EN "EN" at (100, 120) #blue
nand:G1 "NAND" right-of EN by 160 #purple [inputs=2]
port:RDY "RDY" right-of G1 by 160 #emerald
clock:CK "CLK" below G1 by 110 aligned-x with G1 #amber

EN.out -> G1.in1 #blue [ortho digital]
CK.out -> G1.in2 #amber [ortho digital]
G1.out1 -> RDY.in #emerald [ortho digital]`
	},
	{
		fence: 'schemd bounds="900x360" title="CNOT"',
		source: `prepare:QC "|+\\rangle" at (90, 110) #blue
prepare:QT "|0\\rangle" at (90, 250) #blue
cnot:CX "CNOT" at (450, 180) #purple
port:OC "control out" at (780, 110) #emerald
port:OT "target out" at (780, 250) #emerald

QC.out -> CX.in1 #blue [quantum line]
QT.out -> CX.in2 #blue [quantum line]
CX.out1 -> OC.in #purple [quantum line]
CX.out2 -> OT.in #purple [quantum line marker-end=arrow]`
	},
	{
		fence: 'schemd bounds="900x540" title="Two high-pass stages"',
		source: `subcircuit hp [c="100 nF" r="10 k\\Omega"] {
  capacitor:C "{{c}}" at (0, 0) #cyan
  junction:N "v" right-of C by 50 #cyan
  resistor:R "{{r}}" below N by 50 aligned-x with N #amber [orientation=down]
  C.out -> N.node #cyan [ortho]
  N.node -> R.in #amber [ortho]
  expose in = C.in
  expose out = N.node
  expose gnd = R.out
}

source:SIG "V_{sig}" at (90, 160) #blue [type=voltage-ac]
hp:H1 at (260, 160)
hp:H2 at (540, 160) [c="22 nF" r="47 k\\Omega"]
port:OUT "V_{hp}" at (820, 160) #emerald
ground:GND "0 V" at (420, 450) #slate

SIG.positive -> H1.in #blue [ortho]
H1.out -> H2.in #cyan [ortho]
H2.out -> OUT.in #emerald [ortho]
SIG.negative -> GND.in #slate [ortho]
H1.gnd -> GND.in #slate [ortho]
H2.gnd -> GND.in #slate [ortho]`
	},
	{
		fence: 'schemd bounds="680x300" title="Compiler and netlist"',
		source: `class:API "Compiler" at (170, 150) #blue [stereotype="entry" attributes="- limits: Limits" operations="+ compile(src): Svg;+ diagnose(src): List"]
class:NET "Netlist" at (500, 150) #emerald [attributes="- nets: Net[];- nodes: Node[]" operations="+ verify(): Report"]
API.right -> NET.left #slate [ortho association label="builds"]`
	}
];

function loadSeeds() {
	const seeds = [...BUILT_IN_SEEDS];
	if (SEED_DIR) {
		for (const name of readdirSync(SEED_DIR).sort()) {
			if (name.endsWith('.json')) seeds.push(JSON.parse(readFileSync(join(SEED_DIR, name), 'utf8')));
		}
	}
	return seeds;
}

const TOKENS = [
	'->', '<-', '.', ':', '"', '#', '[', ']', '(', ')', ',', '=', '{', '}', ' ', '\t', '\n', '\\',
	'at', 'by', 'with', 'right-of', 'left-of', 'above', 'below', 'aligned-x', 'aligned-y',
	'ortho', 'line', 'bezier', 'net=N', 'net=', 'digital', 'quantum', 'trunk', 'marker-end=arrow',
	'orientation=down', 'orientation=', 'type=', 'inputs=0', 'inputs=64', 'width=0', 'width=65',
	'resistor:', 'junction:J', 'ic:', 'subcircuit', 'cnot:', 'class:', 'port:', 'ground:',
	'0', '-0', '-1', '1e309', '999999999', '1.5', 'NaN', '0x10', '00012', '-999999',
	'#amber', '#nope', '\\frac{', '\\Omega', '_{', '^{', '}', '\u0000', '‮', '😀', '\ud800',
	'\r', '\r\n', ' ', '﻿', '//', '/*', '*/'
];
const NUMBERS = ['0', '-1', '-0', '1', '2', '19', '20', '99999', '100000', '2147483648', '1e3', '0.5', '7.25', '4096', '9007199254740993'];

function mutate(source, random) {
	const pick = (list) => list[Math.floor(random() * list.length)];
	const lines = source.split('\n');
	const operation = Math.floor(random() * 12);
	const at = Math.floor(random() * (source.length + 1));
	switch (operation) {
		case 0: {
			const length = 1 + Math.floor(random() * 8);
			return source.slice(0, at) + source.slice(at + length);
		}
		case 1:
			return source.slice(0, at) + pick(TOKENS) + source.slice(at);
		case 2: {
			const index = Math.floor(random() * lines.length);
			lines.splice(index, 0, lines[index] ?? '');
			return lines.join('\n');
		}
		case 3: {
			const a = Math.floor(random() * lines.length);
			const b = Math.floor(random() * lines.length);
			[lines[a], lines[b]] = [lines[b], lines[a]];
			return lines.join('\n');
		}
		case 4: {
			lines.splice(Math.floor(random() * lines.length), 1);
			return lines.join('\n');
		}
		case 5: {
			let seen = 0;
			const numbers = source.match(/-?\d+(?:\.\d+)?/g) ?? [];
			const target = Math.floor(random() * Math.max(1, numbers.length));
			return source.replace(/-?\d+(?:\.\d+)?/g, (match) => (seen++ === target ? pick(NUMBERS) : match));
		}
		case 6: {
			const ids = [...new Set(source.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])];
			if (ids.length < 2) return source;
			const from = pick(ids);
			return source.replaceAll(new RegExp(`\\b${from}\\b`, 'g'), () => (random() < 0.5 ? pick(ids) : from));
		}
		case 7:
			return source.slice(0, at);
		case 8: {
			const index = Math.floor(random() * lines.length);
			lines[index] = (lines[index] ?? '').replace(/\[[^\]]*\]/, '');
			return lines.join('\n');
		}
		case 9: {
			const index = Math.floor(random() * lines.length);
			const line = lines[index] ?? '';
			lines[index] = line.replace(/\]$/, ` ${pick(TOKENS)}]`);
			return lines.join('\n');
		}
		case 10:
			return source.repeat(2);
		default: {
			const index = Math.floor(random() * lines.length);
			const other = lines[Math.floor(random() * lines.length)] ?? '';
			lines[index] = `${lines[index] ?? ''} ${other}`;
			return lines.join('\n');
		}
	}
}

/** Balanced-tag check: enough to catch truncated or interleaved markup. */
function balanced(svg) {
	const stack = [];
	for (const match of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
		const [, closing, name, selfClosing] = match;
		if (selfClosing) continue;
		if (closing) {
			if (stack.pop() !== name) return false;
		} else {
			stack.push(name);
		}
	}
	return stack.length === 0;
}

function check(source, fenceInfo, mode) {
	let fence;
	try {
		fence = parseSchematicFence(fenceInfo);
	} catch (error) {
		if (error instanceof SchematicSyntaxError) return;
		throw new Error(`parseSchematicFence threw ${error?.constructor?.name}: ${error?.message}`);
	}
	if (fence === undefined) return;
	/* Lines as the compiler counts them: a lone CR breaks a line, as in editors. */
	const sourceLines = source.replace(/\r\n?/g, '\n').split('\n');
	const lineCount = sourceLines.length;
	const lineText = (line) => sourceLines[line - 1] ?? '';

	const started = performance.now();
	let diagnostics;
	try {
		diagnostics = diagnoseSchematic(source, fence);
	} catch (error) {
		throw new Error(`diagnoseSchematic threw ${error?.constructor?.name}: ${error?.message}`);
	}
	if (!Array.isArray(diagnostics)) throw new Error('diagnoseSchematic returned a non-array');
	let previous = 0;
	for (const diagnostic of diagnostics) {
		if (!SCHEMATIC_DIAGNOSTIC_CODES.includes(diagnostic.code)) throw new Error(`unknown code ${diagnostic.code}`);
		if (typeof diagnostic.message !== 'string' || diagnostic.message === '') throw new Error('empty message');
		if (diagnostic.line !== undefined) {
			if (!Number.isInteger(diagnostic.line) || diagnostic.line < 1 || diagnostic.line > lineCount) {
				throw new Error(`diagnostic line ${diagnostic.line} outside 1..${lineCount}: ${diagnostic.message}`);
			}
			if (diagnostic.line < previous) throw new Error('diagnostics out of source order');
			previous = diagnostic.line;
			if (diagnostic.column !== undefined) {
				const width = lineText(diagnostic.line).length;
				if (
					!Number.isInteger(diagnostic.column) ||
					!Number.isInteger(diagnostic.endColumn) ||
					diagnostic.column < 1 ||
					diagnostic.endColumn <= diagnostic.column ||
					diagnostic.endColumn > width + 1
				) {
					throw new Error(
						`column range ${diagnostic.column}..${diagnostic.endColumn} outside line ${diagnostic.line} (width ${width}): ${diagnostic.message}`
					);
				}
			}
		} else if (diagnostics.length > 1) {
			throw new Error(`a line-less diagnostic was reported alongside others: ${diagnostic.message}`);
		}
	}

	let compilation;
	let thrown;
	try {
		compilation = compileSchematic(source, { ...fence, mode });
	} catch (error) {
		if (!(error instanceof SchematicSyntaxError)) {
			throw new Error(`compileSchematic threw ${error?.constructor?.name}: ${error?.message}\n${error?.stack}`);
		}
		thrown = error;
	}
	const elapsed = performance.now() - started;
	if (elapsed > CEILING_MS) throw new Error(`took ${elapsed.toFixed(0)} ms`);

	if (thrown) {
		if (diagnostics.length === 0) throw new Error(`compile threw but diagnose found nothing: ${thrown.message}`);
		if (thrown.line !== undefined && !diagnostics.some((diagnostic) => diagnostic.line === thrown.line)) {
			throw new Error(
				`compile threw at line ${thrown.line} (${thrown.message}) but diagnose reported lines ${diagnostics.map((d) => d.line).join(',')}`
			);
		}
		if (thrown.line !== undefined && (thrown.line < 1 || thrown.line > lineCount)) {
			throw new Error(`thrown line ${thrown.line} outside 1..${lineCount}`);
		}
		return;
	}
	if (diagnostics.length > 0) {
		throw new Error(`compiled, yet diagnose reported: ${diagnostics.map((d) => `${d.line}:${d.code} ${d.message}`).join(' | ')}`);
	}

	const { svg } = compilation;
	/* Labels may legitimately say "NaN"; geometry never may. */
	const numeric = /\s(?:x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|dx|dy|width|height|d|points|transform|viewBox|stroke-width)="([^"]*)"/g;
	for (const [, value] of svg.matchAll(numeric)) {
		if (/NaN|Infinity|undefined/.test(value)) throw new Error(`non-finite geometry in SVG: ${value.slice(0, 60)}`);
	}
	if (svg.includes('[object ')) throw new Error('stringified object in SVG');
	if (!svg.startsWith('<') || !balanced(svg)) throw new Error('unbalanced SVG markup');
	if (compileSchematic(source, { ...fence, mode }).svg !== svg) throw new Error('non-deterministic SVG');
	for (const entry of [...compilation.sourceMap.nodes, ...compilation.sourceMap.wires]) {
		if (entry.line !== undefined && (entry.line < 1 || entry.line > lineCount)) {
			throw new Error(`source map line ${entry.line} outside 1..${lineCount}`);
		}
	}
	verifyNetlist(buildNetlist(compilation.document));
}

const seeds = loadSeeds();
const random = mulberry32(SEED);
let compiled = 0;
let rejected = 0;
const started = performance.now();
for (let index = 0; index < CASES; index += 1) {
	const seed = seeds[Math.floor(random() * seeds.length)];
	let source = seed.source;
	const depth = 1 + Math.floor(random() * 4);
	for (let step = 0; step < depth; step += 1) source = mutate(source, random);
	let fence = seed.fence;
	if (random() < 0.05) fence = fence.replace(/bounds="\d+x\d+"/, `bounds="${Math.floor(random() * 3000)}x${Math.floor(random() * 3000)}"`);
	const mode = ['default', 'embedded-css', 'full'][Math.floor(random() * 3)];
	try {
		check(source, fence, mode);
		try {
			compileSchematic(source, { ...parseSchematicFence(fence), mode });
			compiled += 1;
		} catch {
			rejected += 1;
		}
	} catch (error) {
		const file = `fuzz-failure-${index}.json`;
		writeFileSync(file, `${JSON.stringify({ seed: SEED, case: index, fence, mode, source }, null, '\t')}\n`);
		console.error(`case ${index} (seed ${SEED}) failed: ${error.message}\nwrote ${file}`);
		process.exit(1);
	}
}
console.log(
	`${CASES} cases from ${seeds.length} seeds in ${((performance.now() - started) / 1000).toFixed(1)} s: ${compiled} compiled, ${rejected} rejected, contract held`
);
