"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CampoDeDinheiro } from "@/components/ui/campo-de-dinheiro";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useCatalogoDeProdutos } from "@/hooks/leads/useProdutosDoNegocio";
import { centavosParaCampo, formatCents, parseReaisToCents } from "@/lib/money";
import { ehNovoNoRascunho, type ItemDoRascunho } from "@/lib/leads/rascunho-de-produtos";
import { totalDoItem } from "@/lib/schemas/produtos-do-negocio";
import { X } from "@/lib/ui/icons";

function centsParaTexto(cents: number): string {
  return centavosParaCampo(cents);
}

/**
 * Os produtos do negócio (0660): escolher do catálogo, quantidade e desconto
 * por item. O valor do negócio é a soma — quem calcula é a trigger do banco, e
 * o `LeadFieldsForm` mostra o total daqui no lugar do campo de valor.
 *
 * Cada ação grava NA HORA (30/10/2026), de forma otimista: adicionar e remover
 * no clique; quantidade e desconto ao sair do campo (um PATCH por edição, não
 * por tecla). Quem grava é `useProdutosDoNegocio`, que desfaz e avisa no erro.
 */
export function ProdutosDoNegocio({
  itens,
  moeda,
  podeEditar,
  onAdicionar,
  onRemover,
  onAlterar,
}: {
  itens: ItemDoRascunho[];
  moeda: string;
  podeEditar: boolean;
  onAdicionar: (item: ItemDoRascunho) => void;
  onRemover: (itemId: string) => void;
  onAlterar: (itemId: string, campos: { quantidade?: number; desconto_cents?: number }) => void;
}) {
  const t = useT();
  const catalogo = useCatalogoDeProdutos(podeEditar);
  const ativos = (catalogo.data ?? []).filter((p) => p.ativo);
  // Id da linha enquanto o POST está em voo — único dentro da lista.
  const proximoId = useRef(0);

  function adicionar(productId: string) {
    const p = ativos.find((c) => c.id === productId);
    if (!p) return;
    onAdicionar({
      id: `novo-${productId}-${(proximoId.current += 1)}`,
      product_id: p.id,
      nome: p.nome,
      quantidade: 1,
      preco_unitario_cents: p.preco_cents,
      desconto_cents: 0,
    });
  }

  return (
    <div className="space-y-2" data-testid="produtos-do-negocio" aria-label={t("Produtos")}>
      {itens.length > 0 && (
        <ul className="space-y-2">
          {itens.map((item) => (
            <LinhaDoProduto
              key={item.id}
              item={item}
              moeda={moeda}
              podeEditar={podeEditar}
              onAlterar={(v) => onAlterar(item.id, v)}
              onRemover={() => onRemover(item.id)}
            />
          ))}
        </ul>
      )}
      {podeEditar && (
        <Select value="" onValueChange={adicionar} disabled={ativos.length === 0}>
          <SelectTrigger aria-label={t("Adicionar produto")} data-testid="adicionar-produto">
            <SelectValue
              placeholder={
                ativos.length === 0 ? t("Nenhum produto no catálogo") : t("Adicionar produto")
              }
            />
          </SelectTrigger>
          <SelectContent>
            {ativos.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.nome} — {formatCents(p.preco_cents, moeda)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function LinhaDoProduto({
  item,
  moeda,
  podeEditar,
  onAlterar,
  onRemover,
}: {
  item: ItemDoRascunho;
  moeda: string;
  podeEditar: boolean;
  onAlterar: (v: { quantidade?: number; desconto_cents?: number }) => void;
  onRemover: () => void;
}) {
  const t = useT();
  const [quantidade, setQuantidade] = useState(String(item.quantidade));
  const [desconto, setDesconto] = useState(
    item.desconto_cents ? centsParaTexto(item.desconto_cents) : "",
  );
  // O valor gravado mudou (servidor, ou o desfazer de um erro): o campo acompanha.
  const [gravado, setGravado] = useState({ q: item.quantidade, d: item.desconto_cents });
  if (gravado.q !== item.quantidade || gravado.d !== item.desconto_cents) {
    setGravado({ q: item.quantidade, d: item.desconto_cents });
    setQuantidade(String(item.quantidade));
    setDesconto(item.desconto_cents ? centsParaTexto(item.desconto_cents) : "");
  }
  // A linha recém-adicionada ainda não tem id do banco: editar ou remover agora
  // mandaria o id provisório ao servidor. Fica travada pelo instante do POST.
  const editavel = podeEditar && !ehNovoNoRascunho(item.id);

  const qDigitada = Number.parseInt(quantidade, 10);
  const dDigitado = desconto.trim() === "" ? 0 : parseReaisToCents(desconto);
  const total = totalDoItem({
    ...item,
    quantidade: Number.isInteger(qDigitada) && qDigitada >= 1 ? qDigitada : item.quantidade,
    desconto_cents: dDigitado !== null && dDigitado >= 0 ? dDigitado : item.desconto_cents,
  });

  function conferirQuantidade() {
    const q = Number.parseInt(quantidade, 10);
    if (!Number.isInteger(q) || q < 1) {
      setQuantidade(String(item.quantidade));
      return;
    }
    if (q !== item.quantidade) onAlterar({ quantidade: q });
  }

  function conferirDesconto() {
    const texto = desconto.trim();
    const cents = texto === "" ? 0 : parseReaisToCents(texto);
    if (cents === null || cents < 0) {
      toast.error(t("Desconto inválido"));
      setDesconto(item.desconto_cents ? centsParaTexto(item.desconto_cents) : "");
      return;
    }
    if (cents !== item.desconto_cents) onAlterar({ desconto_cents: cents });
  }

  return (
    <li
      className="space-y-2 rounded-md border border-border p-3 text-sm"
      data-produto={item.product_id ?? ""}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{item.nome}</p>
          <p className="text-xs text-muted-foreground">
            {formatCents(item.preco_unitario_cents, moeda)} {t("cada")}
          </p>
        </div>
        {podeEditar && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            aria-label={`${t("Remover produto")}: ${item.nome}`}
            disabled={!editavel}
            onClick={onRemover}
          >
            <X size={14} aria-hidden />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-3 items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`qtd-${item.id}`} className="text-xs">
            {t("Quantidade")}
          </Label>
          <Input
            id={`qtd-${item.id}`}
            type="number"
            min={1}
            inputMode="numeric"
            className="h-8"
            value={quantidade}
            disabled={!editavel}
            onChange={(e) => setQuantidade(e.target.value)}
            onBlur={conferirQuantidade}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`desc-${item.id}`} className="text-xs">
            {t("Desconto")}
          </Label>
          <CampoDeDinheiro
            id={`desc-${item.id}`}
            moeda={moeda}
            className="h-8"
            value={desconto}
            disabled={!editavel}
            onChange={(e) => setDesconto(e.target.value)}
            onBlur={conferirDesconto}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
          />
        </div>
        <div className="space-y-1 text-right">
          <p className="text-xs text-muted-foreground">{t("Total")}</p>
          <p className="h-8 leading-8 font-medium">{formatCents(total, moeda)}</p>
        </div>
      </div>
    </li>
  );
}
