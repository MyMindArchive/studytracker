import { useMemo } from "react";
import { useApp } from "../../store/app";
import { childrenOf } from "../../lib/rollup";
import { upNext } from "../../lib/focus";
import type { DbNode } from "../../types";

/** Indented <select> over the whole tree. */
export function NodePicker({
  value,
  onChange,
  allowEmpty = true,
  emptyLabel = "— none —",
  leavesOnly = false,
  className = "input",
  autoFocus,
  exclude,
  upNextFirst = false,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  leavesOnly?: boolean;
  className?: string;
  autoFocus?: boolean;
  exclude?: Set<string>;
  /** list the top of the Focus order above the tree */
  upNextFirst?: boolean;
}) {
  const nodes = useApp((s) => s.nodes);
  const rollup = useApp((s) => s.rollup);
  const dailyTarget = useApp((s) => s.settings.daily_target_hours);
  const next = useMemo(
    () => (upNextFirst ? upNext({ nodes, rollup, dailyTargetHours: dailyTarget, today: new Date() }).filter((i) => !exclude?.has(i.node.id)) : []),
    [upNextFirst, nodes, rollup, dailyTarget, exclude],
  );
  const options = useMemo(() => {
    const kids = childrenOf(nodes);
    const out: { node: DbNode; leaf: boolean }[] = [];
    const walk = (parent: string | null) => {
      for (const n of kids.get(parent) ?? []) {
        if (exclude?.has(n.id)) continue;
        const leaf = (kids.get(n.id) ?? []).length === 0;
        out.push({ node: n, leaf });
        walk(n.id);
      }
    };
    walk(null);
    return out;
  }, [nodes, exclude]);

  const treeOptions = options.map(({ node, leaf }) => (
    <option key={node.id} value={node.id} disabled={leavesOnly && !leaf}>
      {"  ".repeat(node.depth)}
      {node.depth > 0 ? "└ " : ""}
      {node.name}
    </option>
  ));

  return (
    <select className={className} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} autoFocus={autoFocus}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {next.length > 0 && (
        <optgroup label="Up next">
          {next.map((i) => (
            <option key={`next-${i.node.id}`} value={i.node.id} disabled={leavesOnly && !options.find((o) => o.node.id === i.node.id)?.leaf}>
              {i.node.name} · {i.subject.id === i.node.id ? "project" : i.subject.name}
            </option>
          ))}
        </optgroup>
      )}
      {next.length > 0 ? <optgroup label="All tasks">{treeOptions}</optgroup> : treeOptions}
    </select>
  );
}
