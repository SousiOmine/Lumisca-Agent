import { assertEquals, assertGreater, assertLess } from "@std/assert";
import type { UiFlowBlock } from "@lumisca/core/shared";
import type { FlowLayout, FlowNodeBox } from "./flow-layout.ts";
import { layoutFlow } from "./flow-layout.ts";

/**
 * Flowchart placement.
 * Positions are computed without the DOM, so the tests only check
 * mechanically that nothing overlaps and that the flow points downward.
 */

function block(
  nodes: UiFlowBlock["nodes"],
  edges: UiFlowBlock["edges"],
): UiFlowBlock {
  return { type: "flow", nodes, edges };
}

function node(
  id: string,
  label = id,
  shape: UiFlowBlock["nodes"][number]["shape"] = "box",
) {
  return { id, label, shape };
}

function edge(from: string, to: string) {
  return { from, to, label: null, dashed: false };
}

function boxOf(layout: FlowLayout, id: string): FlowNodeBox {
  const box = layout.nodes.find((node) => node.id === id);
  if (box === undefined) throw new Error(`no node ${id}`);
  return box;
}

function overlaps(left: FlowNodeBox, right: FlowNodeBox): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function expectNoOverlap(layout: FlowLayout): void {
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      const left = layout.nodes[i];
      const right = layout.nodes[j];
      if (left === undefined || right === undefined) continue;

      assertEquals(
        overlaps(left, right),
        false,
        `${left.id} overlaps ${right.id}`,
      );
    }
  }
}

Deno.test("flow layout: splits layers top to bottom and connects the edges", () => {
  const layout = layoutFlow(
    block([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c")]),
  );

  assertEquals(layout.nodes.length, 3);
  assertEquals(layout.edges.length, 2);
  assertLess(boxOf(layout, "a").y, boxOf(layout, "b").y);
  assertLess(boxOf(layout, "b").y, boxOf(layout, "c").y);
  assertGreater(layout.width, 0);
  assertGreater(layout.height, 0);
  assertEquals(
    layout.edges.every((line) =>
      line.path.startsWith("M ") && line.path.includes(" C ")
    ),
    true,
  );
});

Deno.test("flow layout: a branching diagram still places every node apart", () => {
  const layout = layoutFlow(
    block(
      [node("a"), node("b"), node("c"), node("d", "終了", "pill")],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    ),
  );

  expectNoOverlap(layout);
  // The two branches share a layer.
  assertEquals(boxOf(layout, "b").y, boxOf(layout, "c").y);
});

Deno.test("flow layout: a long label wraps and makes the node taller", () => {
  const short = layoutFlow(block([node("a", "短い")], []));
  const long = layoutFlow(
    block([
      node("a", "これはとても長いラベルなので、いくつもの行に折り返されます"),
    ], []),
  );

  assertEquals(boxOf(short, "a").lines, ["短い"]);
  assertGreater(boxOf(long, "a").lines.length, 1);
  assertGreater(boxOf(long, "a").height, boxOf(short, "a").height);
});

Deno.test("flow layout: explicit newlines become lines as they are", () => {
  const layout = layoutFlow(block([node("a", "1 行目\n2 行目")], []));

  assertEquals(boxOf(layout, "a").lines, ["1 行目", "2 行目"]);
});

Deno.test("flow layout: a loop (back edge) is routed to the right", () => {
  const layout = layoutFlow(
    block([node("a"), node("b")], [
      edge("a", "b"),
      { from: "b", to: "a", label: "やり直す", dashed: true },
    ]),
  );

  assertEquals(layout.edges.length, 2);
  expectNoOverlap(layout);

  const back = layout.edges.find((line) =>
    line.from === "b" && line.to === "a"
  );
  if (back === undefined) throw new Error("no back edge");

  // It stays inside the diagram width (it is not cut off on the right).
  assertGreater(back.labelX, 0);
  assertLess(back.labelX, layout.width);
  assertEquals(
    layout.nodes.every((box) =>
      Number.isFinite(box.x) && Number.isFinite(box.y)
    ),
    true,
  );
});

Deno.test("flow layout: many nodes do not overlap and repeat the same result", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => node(`n${index}`));
  const edges = nodes.slice(1).map((entry, index) =>
    edge(`n${index}`, entry.id)
  );
  const graph = block(nodes, edges);

  const first = layoutFlow(graph);
  const second = layoutFlow(graph);

  assertEquals(first, second);
  expectNoOverlap(first);
  assertEquals(first.nodes.length, 12);
});

Deno.test("flow layout: a single node still gets the surrounding padding", () => {
  const layout = layoutFlow(block([node("only", "開始", "round")], []));
  const box = boxOf(layout, "only");

  assertGreater(layout.width, box.width);
  assertGreater(layout.height, box.height);
  assertEquals(layout.edges, []);
});
