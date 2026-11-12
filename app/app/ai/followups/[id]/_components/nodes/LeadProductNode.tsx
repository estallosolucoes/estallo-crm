"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `lead_product` (Fase 5) no canvas: produto do catálogo no negócio. */
export function LeadProductNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.lead_product}
      label={data.label}
      subtitle={describeNodeConfig("lead_product", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "lead_product", config: data.config as ConfigOf<"lead_product"> })}
    />
  );
}
