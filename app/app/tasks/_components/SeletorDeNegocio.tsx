"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { MagnifyingGlass } from "@/lib/ui/icons";

export interface NegocioEscolhido {
  id: string;
  title: string;
}

/**
 * "Selecionar Oportunidade" — busca negócios pelo título
 * (`GET /api/v1/leads?search=`) para vincular a tarefa a um lead.
 */
export function SeletorDeNegocio({
  aberto,
  aoMudarAbertura,
  aoEscolher,
}: {
  aberto: boolean;
  aoMudarAbertura: (aberto: boolean) => void;
  aoEscolher: (negocio: NegocioEscolhido) => void;
}) {
  const t = useT();
  const [termo, setTermo] = useState("");
  const [busca, setBusca] = useState("");

  // Sem a espera, cada tecla vira uma consulta à API.
  useEffect(() => {
    const id = setTimeout(() => setBusca(termo.trim()), 250);
    return () => clearTimeout(id);
  }, [termo]);

  const lista = useQuery({
    queryKey: ["leads", "seletor", busca],
    queryFn: () =>
      apiClient.get<{ data: NegocioEscolhido[] }>(
        `/api/v1/leads?limit=30${busca ? `&search=${encodeURIComponent(busca)}` : ""}`,
      ),
    enabled: aberto,
    staleTime: 15_000,
  });
  const negocios = lista.data?.data ?? [];

  return (
    <Dialog open={aberto} onOpenChange={aoMudarAbertura}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Selecionar Oportunidade")}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            autoFocus
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder={t("Buscar por oportunidade...")}
            aria-label={t("Buscar por oportunidade...")}
            className="pl-9"
          />
        </div>
        <div className="max-h-80 overflow-y-auto rounded-md border">
          <p className="sticky top-0 bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
            {t("Oportunidades")}
          </p>
          {lista.isLoading ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">{t("Carregando…")}</p>
          ) : negocios.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              {t("Nenhuma oportunidade encontrada.")}
            </p>
          ) : (
            <ul>
              {negocios.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      aoEscolher({ id: n.id, title: n.title });
                      setTermo("");
                      aoMudarAbertura(false);
                    }}
                  >
                    {n.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
