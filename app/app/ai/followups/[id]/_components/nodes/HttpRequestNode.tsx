"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `http_request` (Fase 5) no canvas: chamada a sistema externo por conexão protegida. */
export function HttpRequestNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.http_request}
      label={data.label}
      subtitle={describeNodeConfig("http_request", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "http_request", config: data.config as ConfigOf<"http_request"> })}
    />
  );
}
