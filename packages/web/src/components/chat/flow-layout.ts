import type {
  UiFlowBlock,
  UiFlowEdge,
  UiFlowNode,
  UiFlowShape,
} from "@lumisca/core/shared";

/**
 * Layout of a flowchart.
 *
 * The screen decides where the nodes go (the markup never carries a
 * position). They are stacked in top-to-bottom layers, and each layer is
 * reordered to keep the edges from crossing. The edges that close a cycle
 * ("back edges") are routed around the right side.
 *
 * The whole computation is pure: it uses neither the DOM nor any
 * measurement. Text width is estimated from full-width/half-width
 * character counts, so the same input always produces the same layout.
 */

/** Node width. It is the same for every shape, which keeps centering a
 * layer simple. */
const NODE_WIDTH = 168;

/** Smallest node height. */
const MIN_NODE_HEIGHT = 40;

/** Node inner padding. */
const NODE_PADDING_X = 12;
const NODE_PADDING_Y = 10;

/** Height of one line of text. The renderer uses it to place the lines. */
export const FLOW_LINE_HEIGHT = 16;

/** Padding around the whole diagram. */
const PADDING = 16;

/** Gap between two layers. It also leaves room for an edge label. */
const RANK_GAP = 56;

/** Gap between two nodes of the same layer. */
const SIBLING_GAP = 24;

/** How far a back edge is pushed to the right. */
const BACK_EDGE_GAP = 28;

/** Spacing between two back edges. */
const BACK_EDGE_STEP = 14;

/** Estimated width of one character, used for wrapping a label: 12 for a
 * full-width character, 6.4 for a half-width one. */
const WIDE_CHAR_WIDTH = 12;
const NARROW_CHAR_WIDTH = 6.4;

/** One node as placed on screen. */
export type FlowNodeBox = {
  id: string;
  label: string;
  /** Lines after wrapping. */
  lines: readonly string[];
  shape: UiFlowShape;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** One edge as drawn on screen. */
export type FlowEdgeLine = {
  from: string;
  to: string;
  label: string | null;
  dashed: boolean;
  /** SVG path data. */
  path: string;
  labelX: number;
  labelY: number;
};

/** Size of the whole diagram and everything placed in it. */
export type FlowLayout = {
  width: number;
  height: number;
  nodes: readonly FlowNodeBox[];
  edges: readonly FlowEdgeLine[];
};

/** Place the nodes and edges of a diagram on screen. */
export function layoutFlow(block: UiFlowBlock): FlowLayout {
  const back = backEdges(block);
  const rank = ranks(block, back);
  const layers = orderLayers(block, rank, back);

  // Back edges are routed on the right, so both sides get that much extra
  // room (the diagram stays centered).
  const backMargin = back.size === 0
    ? 0
    : BACK_EDGE_GAP + back.size * BACK_EDGE_STEP + 12;
  const sidePadding = PADDING + backMargin;

  // Pass 1: measure every node's height, wrapping included.
  const sizes = new Map(block.nodes.map((node) => [node.id, measure(node)]));

  // Pass 2: take the diagram width from the widest layer.
  let contentWidth = 0;
  for (const layer of layers) {
    contentWidth = Math.max(contentWidth, layerWidth(layer.length));
  }
  const width = contentWidth + sidePadding * 2;

  const nodes: FlowNodeBox[] = [];
  const boxes = new Map<string, FlowNodeBox>();

  let y = PADDING;
  for (const layer of layers) {
    let rowHeight = 0;
    for (const id of layer) {
      rowHeight = Math.max(
        rowHeight,
        sizes.get(id)?.height ?? MIN_NODE_HEIGHT,
      );
    }

    let x = (width - layerWidth(layer.length)) / 2;
    for (const id of layer) {
      const node = block.nodes.find((entry) => entry.id === id);
      const size = sizes.get(id);
      if (node === undefined || size === undefined) continue;

      const box: FlowNodeBox = {
        id,
        label: node.label,
        lines: size.lines,
        shape: node.shape,
        x,
        y,
        width: NODE_WIDTH,
        height: size.height,
      };
      nodes.push(box);
      boxes.set(id, box);
      x += NODE_WIDTH + SIBLING_GAP;
    }

    y += rowHeight + RANK_GAP;
  }

  const height = y - RANK_GAP + PADDING;
  const edges: FlowEdgeLine[] = [];
  let backIndex = 0;

  for (const edge of block.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (from === undefined || to === undefined) continue;

    if (back.has(edge)) {
      edges.push(backEdgeLine(edge, from, to, backIndex));
      backIndex += 1;
      continue;
    }
    edges.push(forwardEdgeLine(edge, from, to));
  }

  return { width, height, nodes, edges };
}

/** Width of a layer holding `count` nodes. */
function layerWidth(count: number): number {
  return count * NODE_WIDTH + Math.max(0, count - 1) * SIBLING_GAP;
}

/** Decide a node's size and its wrapped label. */
function measure(node: UiFlowNode): { lines: string[]; height: number } {
  // A diamond leaves less room for text, so it wraps earlier.
  const textWidth = node.shape === "diamond"
    ? NODE_WIDTH - 72
    : NODE_WIDTH - NODE_PADDING_X * 2;
  const lines = wrap(node.label, textWidth);
  const height = Math.max(
    MIN_NODE_HEIGHT,
    lines.length * FLOW_LINE_HEIGHT + NODE_PADDING_Y * 2,
  );
  return { lines, height };
}

/** Wrap a label by estimated character width. Explicit newlines are kept. */
function wrap(label: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  let width = 0;

  for (const char of label) {
    if (char === "\n") {
      lines.push(current);
      current = "";
      width = 0;
      continue;
    }

    const charWidth = widthOf(char);
    if (width + charWidth > maxWidth && current.length > 0) {
      lines.push(current);
      current = "";
      width = 0;
    }

    current += char;
    width += charWidth;
  }

  lines.push(current);
  return lines;
}

/** Approximate width of one character. Full-width (Japanese etc.) counts
 * as wide. */
function widthOf(char: string): number {
  return (char.codePointAt(0) ?? 0) >= 0x2e80
    ? WIDE_CHAR_WIDTH
    : NARROW_CHAR_WIDTH;
}

/**
 * Find the edges that close a cycle (back edges).
 * Walks depth-first and treats an edge into a node still on the current
 * walk as a back edge. Removing those leaves a DAG that always flows from
 * top to bottom.
 */
function backEdges(block: UiFlowBlock): ReadonlySet<UiFlowEdge> {
  const back = new Set<UiFlowEdge>();
  const state = new Map<string, 0 | 1 | 2>();

  const visit = (id: string): void => {
    state.set(id, 1);

    for (const edge of block.edges) {
      if (edge.from !== id) continue;

      const next = state.get(edge.to) ?? 0;
      if (next === 1) {
        back.add(edge);
        continue;
      }
      if (next === 0) visit(edge.to);
    }

    state.set(id, 2);
  };

  for (const node of block.nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  }

  return back;
}

/**
 * Split the nodes into top-to-bottom layers.
 * On the DAG without the back edges, a node's layer is its longest
 * distance from an entry (longest path).
 */
function ranks(
  block: UiFlowBlock,
  back: ReadonlySet<UiFlowEdge>,
): Map<string, number> {
  const forward = block.edges.filter((edge) => !back.has(edge));
  const rank = new Map(block.nodes.map((node) => [node.id, 0]));
  const incoming = new Map(block.nodes.map((node) => [node.id, 0]));

  for (const edge of forward) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const queue = block.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined) continue;

    for (const edge of forward) {
      if (edge.from !== id) continue;

      const next = (rank.get(id) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) rank.set(edge.to, next);

      const remaining = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }

  return rank;
}

/**
 * Order the nodes within each layer.
 * A few up-and-down rounds move nodes toward the barycenter of their
 * neighbors in the adjacent layer to reduce edge crossings. Nodes without
 * such a neighbor stay at the end, in their original order.
 */
function orderLayers(
  block: UiFlowBlock,
  rank: ReadonlyMap<string, number>,
  back: ReadonlySet<UiFlowEdge>,
): string[][] {
  const layers: string[][] = [];
  for (const node of block.nodes) {
    const level = rank.get(node.id) ?? 0;
    const layer = layers[level];
    if (layer === undefined) {
      layers[level] = [node.id];
    } else {
      layer.push(node.id);
    }
  }

  const position = new Map<string, number>();
  const remember = (): void => {
    for (const layer of layers) {
      layer.forEach((id, index) => {
        position.set(id, index);
      });
    }
  };
  remember();

  const neighborsOf = (id: string, side: "in" | "out"): string[] => {
    const ids: string[] = [];
    for (const edge of block.edges) {
      if (back.has(edge)) continue;
      if (side === "in" && edge.to === id) ids.push(edge.from);
      if (side === "out" && edge.from === id) ids.push(edge.to);
    }
    return ids;
  };

  const sortLayer = (layer: string[], side: "in" | "out"): void => {
    const center = new Map<string, number>();
    for (const id of layer) {
      const adjacent = neighborsOf(id, side).filter((other) =>
        position.has(other)
      );
      center.set(
        id,
        adjacent.length === 0 ? Number.POSITIVE_INFINITY : adjacent.reduce(
          (sum, other) => sum + (position.get(other) ?? 0),
          0,
        ) / adjacent.length,
      );
    }

    const before = new Map(layer.map((id, index) => [id, index]));
    layer.sort(
      (left, right) =>
        (center.get(left) ?? 0) - (center.get(right) ?? 0) ||
        (before.get(left) ?? 0) - (before.get(right) ?? 0),
    );
    layer.forEach((id, index) => {
      position.set(id, index);
    });
  };

  for (let round = 0; round < 4; round += 1) {
    for (let level = 1; level < layers.length; level += 1) {
      const layer = layers[level];
      if (layer !== undefined) sortLayer(layer, "in");
    }
    for (let level = layers.length - 2; level >= 0; level -= 1) {
      const layer = layers[level];
      if (layer !== undefined) sortLayer(layer, "out");
    }
  }

  return layers;
}

/** An edge that flows downward. It joins the middle of the lower side to
 * the middle of the upper side with a vertical curve. */
function forwardEdgeLine(
  edge: UiFlowEdge,
  from: FlowNodeBox,
  to: FlowNodeBox,
): FlowEdgeLine {
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const middleY = (startY + endY) / 2;

  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    dashed: edge.dashed,
    path:
      `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: middleY,
  };
}

/** A back edge. It loops around the right side, and each one is pushed a
 * little further out so the lines do not overlap. */
function backEdgeLine(
  edge: UiFlowEdge,
  from: FlowNodeBox,
  to: FlowNodeBox,
  index: number,
): FlowEdgeLine {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width;
  const endY = to.y + to.height / 2;
  const controlX = Math.max(startX, endX) + BACK_EDGE_GAP +
    index * BACK_EDGE_STEP;

  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    dashed: edge.dashed,
    path:
      `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
    // Position at t=0.5 of the cubic Bezier.
    labelX: (startX + endX + controlX * 6) / 8,
    labelY: (startY + endY) / 2,
  };
}
