import { useMemo } from "react";
import { useApp } from "../../store/app";
import { childrenOf } from "../../lib/rollup";
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
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  leavesOnly?: boolean;
  className?: string;
  autoFocus?: boolean;
  exclude?: Set<string>;
}) {
  const nodes = useApp((s) => s.nodes);
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

  return (
    <select className={className} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} autoFocus={autoFocus}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {options.map(({ node, leaf }) => (
        <option key={node.id} value={node.id} disabled={leavesOnly && !leaf}>
          {"  ".repeat(node.depth)}
          {node.depth > 0 ? "└ " : ""}
          {node.name}
        </option>
      ))}
    </select>
  );
}
