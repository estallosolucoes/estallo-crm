"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `map_data` (Fase 4) no canvas: monta campos a partir dos blocos anteriores, sem efeito. */
export function MapDataNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.map_data}
      label={data.label}
      subtitle={describeNodeConfig("map_data", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "map_data", config: data.config as ConfigOf<"map_data"> })}
    />
  );
}
