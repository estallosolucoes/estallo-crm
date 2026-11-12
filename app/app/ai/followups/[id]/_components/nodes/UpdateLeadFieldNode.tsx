"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `update_lead_field` (Fase 5) no canvas: grava campo ou valor do negócio. */
export function UpdateLeadFieldNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.update_lead_field}
      label={data.label}
      subtitle={describeNodeConfig("update_lead_field", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "update_lead_field", config: data.config as ConfigOf<"update_lead_field"> })}
    />
  );
}
