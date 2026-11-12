"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `assign_lead_owner` (Fase 5) no canvas: troca o responsável do negócio. */
export function AssignLeadOwnerNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.assign_lead_owner}
      label={data.label}
      subtitle={describeNodeConfig("assign_lead_owner", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "assign_lead_owner", config: data.config as ConfigOf<"assign_lead_owner"> })}
    />
  );
}
