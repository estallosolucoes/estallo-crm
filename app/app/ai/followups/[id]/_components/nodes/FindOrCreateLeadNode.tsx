"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `find_or_create_lead` (Fase 5) no canvas. */
export function FindOrCreateLeadNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.find_or_create_lead}
      label={data.label}
      subtitle={describeNodeConfig("find_or_create_lead", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "find_or_create_lead", config: data.config as ConfigOf<"find_or_create_lead"> })}
    />
  );
}
