"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `add_note` (Fase 5) no canvas: nota interna no negócio ou na conversa. */
export function AddNoteNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.add_note}
      label={data.label}
      subtitle={describeNodeConfig("add_note", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "add_note", config: data.config as ConfigOf<"add_note"> })}
    />
  );
}
