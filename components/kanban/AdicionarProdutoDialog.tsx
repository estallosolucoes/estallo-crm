"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CampoDeDinheiro } from "@/components/ui/campo-de-dinheiro";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useCatalogoDeProdutos, useProdutosDoNegocio } from "@/hooks/leads/useProdutosDoNegocio";
import { formatCents, MOEDA_PADRAO, parseReaisToCents } from "@/lib/money";
import { produtoDoNegocioCreateSchema, totalDoItem } from "@/lib/schemas/produtos-do-negocio";

/**
 * "ADICIONAR PRODUTO" FORA DO DOSSIÊ (Inbox › Leads recentes › ⋯).
 *
 * Não é um segundo caminho: grava pelo MESMO `useProdutosDoNegocio().adicionar`
 * do dossiê (mesma rota, mesmo schema, mesma auditoria, mesma invalidação do
 * quadro) e o fechamento previsto pelo MESMO `useEditLead`. O que muda é só a
 * forma — um diálogo curto em vez da ficha inteira.
 *
 * O VALOR NÃO É EDITÁVEL, de propósito: a rota copia o preço do catálogo e não
 * aceita preço no corpo (`produtoDoNegocioCreateSchema` é `.strict()`). Um campo
 * editável aqui seria promessa que o servidor descarta.
 */
export function AdicionarProdutoDialog({
  aberto,
  aoMudarAbertura,
  lead,
  aoAdicionar,
}: {
  aberto: boolean;
  aoMudarAbertura: (aberto: boolean) => void;
  lead: {
    id: string;
    title: string;
    pipeline_id: string;
    currency: string | null;
    expected_close_date?: string | null;
  };
  /** Depois de gravado — quem abriu relê o que mostra (o valor do negócio mudou). */
  aoAdicionar?: () => void;
}) {
  const t = useT();
  const moeda = lead.currency ?? MOEDA_PADRAO;
  const catalogo = useCatalogoDeProdutos(aberto);
  const ativos = (catalogo.data ?? []).filter((p) => p.ativo);
  const produtos = useProdutosDoNegocio(lead.id, lead.pipeline_id);
  const editar = useEditLead(lead.pipeline_id);

  const fechamentoInicial = lead.expected_close_date ?? "";
  const [produtoId, setProdutoId] = useState("");
  const [quantidade, setQuantidade] = useState("1");
  const [desconto, setDesconto] = useState("");
  const [fechamento, setFechamento] = useState(fechamentoInicial);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const produto = ativos.find((p) => p.id === produtoId);
  const qtd = Number(quantidade);
  const qtdValida = Number.isInteger(qtd) && qtd >= 1 && qtd <= 100_000;
  const descontoCents = desconto.trim() === "" ? 0 : parseReaisToCents(desconto);
  const descontoValido = descontoCents !== null && descontoCents >= 0;
  const total = produto
    ? totalDoItem({
        quantidade: qtdValida ? qtd : 1,
        preco_unitario_cents: produto.preco_cents,
        desconto_cents: descontoValido ? (descontoCents ?? 0) : 0,
      })
    : null;

  async function salvar() {
    setErro(null);
    const corpo = produtoDoNegocioCreateSchema.safeParse({
      product_id: produtoId,
      quantidade: qtd,
      desconto_cents: descontoCents ?? -1,
    });
    if (!produto || !corpo.success || !qtdValida || !descontoValido) {
      setErro(
        !produto
          ? t("Escolha um produto.")
          : !qtdValida
            ? t("Quantidade deve ser um número inteiro entre 1 e 100000.")
            : t("Desconto inválido"),
      );
      return;
    }
    setSalvando(true);
    try {
      const ok = await produtos.adicionar({
        id: `novo-${produto.id}-${Date.now()}`,
        product_id: produto.id,
        nome: produto.nome,
        quantidade: corpo.data.quantidade ?? 1,
        preco_unitario_cents: produto.preco_cents,
        desconto_cents: corpo.data.desconto_cents ?? 0,
      });
      if (!ok) return; // o motivo já subiu no toast do hook; o diálogo fica aberto
      if (fechamento !== fechamentoInicial) {
        try {
          await editar.mutateAsync({
            leadId: lead.id,
            patch: { expected_close_date: fechamento || null },
          });
        } catch {
          // O produto entrou; só a data falhou (o hook já mostrou o motivo).
          aoAdicionar?.();
          return;
        }
      }
      toast.success(t("Produto adicionado"));
      aoAdicionar?.();
      aoMudarAbertura(false);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !salvando && aoMudarAbertura(v)}>
      <DialogContent className="sm:max-w-md" data-testid="adicionar-produto-dialogo">
        <DialogHeader>
          <DialogTitle>{t("Adicionar produto")}</DialogTitle>
          <DialogDescription className="truncate" title={lead.title}>
            {lead.title}
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void salvar();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="adicionar-produto-produto">{t("Produto")}</Label>
            <Select
              value={produtoId}
              onValueChange={setProdutoId}
              disabled={salvando || ativos.length === 0}
            >
              <SelectTrigger id="adicionar-produto-produto" data-testid="adicionar-produto-produto">
                <SelectValue
                  placeholder={
                    catalogo.isLoading
                      ? t("Carregando…")
                      : ativos.length === 0
                        ? t("Nenhum produto no catálogo")
                        : t("Escolha um produto")
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
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="adicionar-produto-quantidade">{t("Quantidade")}</Label>
              <Input
                id="adicionar-produto-quantidade"
                type="number"
                min={1}
                max={100_000}
                step={1}
                inputMode="numeric"
                value={quantidade}
                disabled={salvando}
                aria-invalid={!qtdValida || undefined}
                onChange={(e) => setQuantidade(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adicionar-produto-desconto">{t("Desconto")}</Label>
              <CampoDeDinheiro
                id="adicionar-produto-desconto"
                moeda={moeda}
                value={desconto}
                disabled={salvando}
                aria-invalid={!descontoValido || undefined}
                onChange={(e) => setDesconto(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="adicionar-produto-valor">{t("Valor")}</Label>
              <Input
                id="adicionar-produto-valor"
                readOnly
                tabIndex={-1}
                value={total === null ? "—" : formatCents(total, moeda)}
                data-testid="adicionar-produto-valor"
                className="bg-muted/40 tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                {produto
                  ? `${formatCents(produto.preco_cents, moeda)} ${t("cada")}, ${t("preço do catálogo")}`
                  : t("Preço do catálogo")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adicionar-produto-fechamento">{t("Fechamento previsto")}</Label>
              <Input
                id="adicionar-produto-fechamento"
                type="date"
                value={fechamento}
                disabled={salvando}
                onChange={(e) => setFechamento(e.target.value)}
              />
            </div>
          </div>

          {erro && (
            <p role="alert" className="text-sm text-destructive">
              {erro}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={salvando}
              onClick={() => aoMudarAbertura(false)}
            >
              {t("Cancelar")}
            </Button>
            <Button
              type="submit"
              disabled={salvando || !produto}
              data-testid="adicionar-produto-salvar"
            >
              {salvando ? t("Adicionando…") : t("Adicionar produto")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
