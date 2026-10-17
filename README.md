<p align="center">
  <img src="https://github.com/schemd/web/blob/main/src/lib/assets/brand/schemd-logo.svg" alt="Schemd — engineering vectors" width="640" />
</p>

# @schemd/core

`schemd` — pronounced like “skemd” (`/skɛmd/`) — is a strict, deterministic text-to-SVG compiler for electrical, digital, quantum, and UML diagrams. It has no runtime dependencies and never touches a DOM, Canvas, browser layout, external font, raster asset, or `getBBox()`.

**The [documentation site](https://schemd.johnowolabiidogun.dev/docs/1.0/overview) is the reference.** Every page there is versioned per release line and every example is compiled by the real engine. This file is the short tour.

Version 1.0.1 needs Node.js 24 or newer.

[Docs](https://schemd.johnowolabiidogun.dev/docs/1.0/overview) · [Playground](https://schemd.johnowolabiidogun.dev/playground) · [Inspector](https://schemd.johnowolabiidogun.dev/inspector/1.0.1) · [Changelog](./CHANGELOG.md) · [Roadmap](./ROADMAP.md)

## Install

```sh
npm i @schemd/core # or bun add / pnpm add / yarn add
```

## Compile

```ts
import { compileSchematic, parseSchematicFence } from "@schemd/core";

const fence = parseSchematicFence('schemd bounds="760x460" title="RC low-pass filter"')!;

const { svg, metrics } = compileSchematic(
  `source:VIN "AC" at (90, 150) #blue [type=voltage-ac]
resistor:R1 "1 k\\Omega" right-of VIN by 190 #amber
junction:VOUT "V_{out}" right-of R1 by 190 #cyan
capacitor:C1 "100 nF" below VOUT by 140 #cyan [orientation=down]

VIN.positive -> R1.in #blue [line]
R1.out -> VOUT.node #amber [line]
VOUT.node -> C1.in #cyan [ortho]`,
  { ...fence, mode: "full" },
);
```

Two kinds of line, and a part may state its position either way:

```text
kind:ID "label" at (x, y) #color [options]
kind:ID "label" right-of REF by 190 #color [options]
SOURCE.port -> TARGET.port #color [line|bezier|ortho options]
```

A block you draw more than once can be written once as a sub-circuit and placed by name. Instances may nest, take parameters, and are reached through the terminals the block exposes:

```text
subcircuit divider [top="10 k" bottom="10 k"] {
  resistor:RT "{{top}}" at (0, 0) #amber [orientation=down]
  resistor:RB "{{bottom}}" below RT by 40 #amber [orientation=down]
  RT.out -> RB.in #amber [ortho]
  expose mid = RT.out
}
divider:U1 at (200, 100) [top="22 k"]
U1.mid -> ADC.in #blue [ortho]
```

A net that reaches several terminals is drawn as a tree: each further wire leaves the copper its net already has, with a junction dot, instead of running back to its own pin.

Bad variants, duplicate options, unknown ports, mismatched bus widths, unsafe colours, and out-of-bounds geometry all fail with a line-accurate diagnostic before any SVG is written. `diagnoseSchematic` lists every problem in a document at once, each with its line and column range, for an editor to underline.

## What it compiles

Electrical, digital, quantum, and UML families — the full vocabulary is in the [component reference](https://schemd.johnowolabiidogun.dev/docs/1.0/component-reference).

A compiled diagram is also a model. `buildNetlist` gives you nodes, nets, and edges; `verifyNetlist` runs seven design rules over them; `describeSchematic` turns the same connectivity into prose for a screen reader. The compilation also hands back its own working: `sourceMap` (every vector's declaration line), `placements` (what each relation resolved to), and `routing` (negotiation rounds, torn-up wires, per-cell congestion).

And the output is readable back. `snapshotSchematic` writes a text digest of the geometry, so a routing change reviews as a handful of moved coordinates rather than an image diff; `parseSchematicSvg` reads a `full`-mode SVG back into declarations, naming what the markup does not carry rather than guessing at it.

## Before you rely on it

Please read the [limitations](https://schemd.johnowolabiidogun.dev/docs/1.0/overview#limitations) before treating a clean compile as an engineering result. The short version:

- **`verifyNetlist` is structural linting, not verification.** It cannot tell you anything about analog correctness, timing, impedance, drive strength, metastability, or quantum validity. A clean result means no rule fired.
- **Routing is heuristic and bounded.** Each net is routed once on a channel lattice in an order taken from the geometry, and any contention left over is negotiated away for a bounded number of rounds. Wires are placed where a draughtsman would put them in the common cases, not provably optimally, and a document crowded beyond what the lattice can separate is rejected with the wire that could not be placed.
- **The model is flat underneath.** Sub-circuits are expanded into ordinary parts before anything else reads the document, so the netlist, the SVG and the decompiler all see the flattened drawing — there are no sub-sheets, no ports between pages, no simulation, no timing analysis, and no certification. It suits documentation, teaching, and schematics rather than large engineering designs.
- **Text is measured for Arial and placed without regard to its neighbours.** Label widths match Arial, Helvetica, Liberation Sans and Arimo, which the SVG names as its font; on a crowded sheet a label can overlap another part or a wire. Space parts by at least a label's width.
- **Compiling source you did not write?** Pass [`limits`](https://schemd.johnowolabiidogun.dev/docs/1.0/limits) and a timeout of your own.
- **Published performance figures are narrow.** Warm medians on one machine. Run `bun run benchmark` on yours.

## Compatibility

1.0 reads the same language and keeps every entry point's signature; its API additions are `diagnoseSchematic`, `SCHEMATIC_DIAGNOSTIC_CODES` and the `column`, `endColumn` and `code` fields on `SchematicSyntaxError`. Drawings change, because the router is new: multi-terminal nets are trees, wires written to a junction part meet at it, a wire crossing its own net is dotted, bridges sit on vertical runs, text is measured rather than squeezed, every terminal of a digital block has its own slot, and geometry is exact to three decimals. A document 0.8 rejected is rejected with the same message, except that a crossing the new router can route around now compiles. There are two new rejections: a line or Bézier wire drawn through another component's pin, which reads as a connection it is not, and a flip-flop terminal named with another variant's letter, which 0.8 drew on the first input. The [changelog](./CHANGELOG.md) lists every change.

Upgrading across 0.4 as well? See [migration](https://schemd.johnowolabiidogun.dev/docs/1.0/overview#migrate) — port aliases now report their canonical terminal, and the component and connection ceilings are gone.

## Contributing

`bun install`, then `bun run test:visual:install` once, then `bun run release:check`. [CONTRIBUTING.md](./CONTRIBUTING.md) covers the invariants and what each gate protects.

[Issues](https://github.com/schemd/core/issues) · [MIT](./LICENSE)
