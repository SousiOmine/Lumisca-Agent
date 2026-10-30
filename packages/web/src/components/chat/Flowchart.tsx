import { useId, useMemo } from "preact/compat";
import type { UiFlowBlock, UiFlowShape } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import { FLOW_LINE_HEIGHT, layoutFlow } from "./flow-layout.ts";

/**
 * A flow chart drawn from the card markup's nodes and edges.
 *
 * The layout is computed here, not by the model: the markup names nodes and
 * edges, and their positions come from `layoutFlow` (a pure function, so the
 * same card always draws the same picture). Sizes are in CSS pixels and the
 * container scrolls horizontally rather than shrinking — a shrunken chart is
 * unreadable on a phone, a scrollable one is not.
 */

/** The `<marker>` id must be unique per chart: two charts on one page would
 * otherwise share an arrowhead, and the second would lose its own. */
export function Flowchart({ block }: { block: UiFlowBlock }) {
  const t = useT();
  const markerId = `flow-arrow-${useId()}`;
  const layout = useMemo(() => layoutFlow(block), [block]);

  return (
    <div className="ui-flow">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={t("panels.ui.flow")}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => (
          <g key={`e${index}`}>
            <path
              d={edge.path}
              fill="none"
              stroke="var(--border-strong)"
              stroke-width="1.2"
              stroke-dasharray={edge.dashed ? "4 4" : undefined}
              marker-end={`url(#${markerId})`}
            />
            {edge.label !== null && (
              <text
                x={edge.labelX}
                y={edge.labelY}
                text-anchor="middle"
                font-size="10"
                fill="var(--text-dim)"
                paint-order="stroke"
                stroke="var(--surface)"
                stroke-width="4"
              >
                {edge.label}
              </text>
            )}
          </g>
        ))}
        {layout.nodes.map((node) => (
          <g key={node.id}>
            {shapeOf(node)}
            {node.lines.map((line, index) => (
              <text
                key={`${node.id}-${index}`}
                x={node.x + node.width / 2}
                y={lineY(node, index)}
                text-anchor="middle"
                font-size="12"
                fill="var(--text)"
              >
                {line}
              </text>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** A node's outline, in its shape's own geometry. The text is drawn by the
 * caller on top, so this returns the plain shape alone. */
function shapeOf(
  node: {
    x: number;
    y: number;
    width: number;
    height: number;
    shape: UiFlowShape;
  },
) {
  const common = {
    fill: "var(--surface-2)",
    stroke: "var(--border-strong)",
    "stroke-width": "1.2",
  };
  switch (node.shape) {
    case "diamond":
      return (
        <polygon
          points={[
            `${node.x + node.width / 2},${node.y}`,
            `${node.x + node.width},${node.y + node.height / 2}`,
            `${node.x + node.width / 2},${node.y + node.height}`,
            `${node.x},${node.y + node.height / 2}`,
          ].join(" ")}
          {...common}
        />
      );
    case "pill":
      return (
        <rect
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={node.height / 2}
          {...common}
        />
      );
    case "round":
      return (
        <rect
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={16}
          {...common}
        />
      );
    default:
      return (
        <rect
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={6}
          {...common}
        />
      );
  }
}

/** The baseline of one line of a node's label, centred in the box. */
function lineY(
  node: { y: number; height: number; lines: readonly string[] },
  index: number,
): number {
  const blockHeight = node.lines.length * FLOW_LINE_HEIGHT;
  return node.y + node.height / 2 - blockHeight / 2 + 4 +
    index * FLOW_LINE_HEIGHT;
}
