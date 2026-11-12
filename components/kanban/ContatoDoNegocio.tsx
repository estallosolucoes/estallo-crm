"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useContact } from "@/hooks/contacts/useContact";
import { useCamposPersonalizados } from "@/hooks/campos/useCamposPersonalizados";
import { campoVisivelNoLead } from "@/lib/campos/definicao";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useT } from "@/hooks/i18n/useT";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { useContatosRelacionados } from "@/hooks/leads/useContatosRelacionados";
import {
  aplicarLinks,
  EXEMPLO_DE_LINK,
  lerLinks,
  normalizarLink,
  TIPOS_DE_LINK,
  tiposInvalidos,
  type LinksDoContato,
  type TipoDeLink,
} from "@/lib/leads/links-de-contato";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { ArrowSquareOut } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";

interface Props {
  contactId: string | null;
  pipelineId: string;
  /**
   * A âncora das pessoas relacionadas (#1506 F1). Opcional de propósito: quem
   * só tem o contato (card, testes do dossiê) não consulta rota nenhuma —
   * `useContatosRelacionados` segura a chamada sem `leadId`.
   */
  leadId?: string | null;
  /** Onde o negócio está — decide quais campos de CONTATO aparecem (cadastro central). */
  lead?: { pipeline_id: string; stage_id: string } | null;
}

/**
 * Os dados do CLIENTE dentro do dossiê do negócio: telefone e e-mail numa aba,
 * links (Instagram, site, Google Meu Negócio…) na outra, e ABAIXO do principal
 * as outras pessoas do mesmo negócio (#1506 F1).
 *
 * Telefone e e-mail são LEITURA aqui, de propósito: o telefone exige E.164 e
 * passa por normalização e checagem de duplicidade no cadastro do contato, e
 * reimplementar isso num painel lateral seria uma segunda regra para divergir.
 * A ficha completa (`/app/contacts/[id]`) é um clique, e é onde essa regra mora.
 *
 * Os LINKS são editáveis aqui: não têm regra além de "ser um endereço http(s)",
 * e são o dado que o funil mais precisa preencher de passagem.
 *
 * As PESSOAS RELACIONADAS são só leitura nesta fatia: escrever (adicionar,
 * remover, dar papel) é a F2 da mesma issue, com `POST`/`DELETE` nesta rota.
 */
export function ContatoDoNegocio({ contactId, pipelineId, leadId, lead = null }: Props) {
  const t = useT();
  return (
    <>
      {contactId ? (
        <ContatoVinculado contactId={contactId} pipelineId={pipelineId} lead={lead} />
      ) : (
        <p className="text-xs text-text-muted">{t("Este negócio não tem contato vinculado.")}</p>
      )}
      <PessoasRelacionadas leadId={leadId ?? null} />
    </>
  );
}

function ContatoVinculado({
  contactId,
  pipelineId,
  lead,
}: {
  contactId: string;
  pipelineId: string;
  lead: { pipeline_id: string; stage_id: string } | null;
}) {
  const t = useT();
  const { data, isLoading, isError, refetch, isFetching } = useContact(contactId);
  const contato = data?.data;
  const cadastro = useCamposPersonalizados("contact");
  const camposDoContato: CustomFieldDef[] = (cadastro.data?.definicoes ?? [])
    .filter((d) => campoVisivelNoLead(d, lead))
    .map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      required: d.obrigatorio !== "nao",
      options: d.options,
    }));

  if (isLoading) {
    return (
      <div aria-busy="true" aria-label={t("Carregando…")} className="space-y-2">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (isError || !contato) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">{t("Não consegui carregar o contato.")}</p>
        <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  return (
    <Tabs defaultValue="dados" data-testid="contato-do-negocio">
      <TabsList>
        <TabsTrigger value="dados">{t("Dados")}</TabsTrigger>
        <TabsTrigger value="links">{t("Links")}</TabsTrigger>
        {camposDoContato.length > 0 && <TabsTrigger value="campos">{t("Campos")}</TabsTrigger>}
      </TabsList>
      <TabsContent value="dados">
        <DadosDoContato contato={contato} />
      </TabsContent>
      <TabsContent value="links">
        {/* `key` = updated_at: quando o contato é relido depois de salvar (ou
            editado em outra tela), o formulário reinicia com o valor do
            servidor, sem um efeito de sincronização que pisaria no que a
            pessoa está digitando. */}
        <FormularioDeLinks key={contato.updated_at} contato={contato} pipelineId={pipelineId} />
      </TabsContent>
      {camposDoContato.length > 0 && (
        <TabsContent value="campos">
          <CamposDoContato key={contato.updated_at} contato={contato} campos={camposDoContato} />
        </TabsContent>
      )}
    </Tabs>
  );
}

/**
 * As outras pessoas do negócio (#1506 F1): a lista que faltava embaixo do
 * contato principal.
 *
 * Sumida por padrão, e não "vazia": negócio sem relacionado não ganha um título
 * de seção pendurado no dossiê, e quem carrega a tela não vê nem um piscar de
 * lista vazia antes de a resposta chegar. O erro NÃO some — ele é a única coisa
 * que a pessoa tem a ler quando a rota falha.
 *
 * O `papel` vem do `metadata` escrito pelo atendente (texto livre, F2 limita a
 * 40) e o nome vem do cadastro: dado de quem usou o produto, não frase de
 * interface, então os dois saem como vieram em qualquer idioma.
 */
function PessoasRelacionadas({ leadId }: { leadId: string | null }) {
  const t = useT();
  const { data, isLoading, isError } = useContatosRelacionados(leadId);
  if (isError) {
    return (
      <p className="mt-2 text-xs text-destructive">
        {t("Não consegui carregar as pessoas relacionadas.")}
      </p>
    );
  }
  if (isLoading) return null;
  const pessoas = data?.data ?? [];
  if (pessoas.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-border pt-3" data-testid="pessoas-relacionadas">
      <p className="text-[11px] leading-4 font-semibold tracking-[0.035em] text-text-muted uppercase">
        {t("Pessoas relacionadas")}
      </p>
      <ul className="space-y-1">
        {pessoas.map((pessoa) => (
          <li key={pessoa.contact_id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="min-w-0 truncate">{pessoa.nome ?? "—"}</span>
            {pessoa.papel && <span className="text-text-muted">({pessoa.papel})</span>}
            {pessoa.anonimizado && <span className="text-text-muted">{t("Anonimizado")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DadosDoContato({ contato }: { contato: Contact }) {
  const t = useT();
  const nome = nomeDoContato(contato);
  const digitos = (contato.phone_number ?? "").replace(/\D/g, "");

  return (
    <div className="space-y-2 text-sm">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-xs text-text-muted">{t("Nome")}</dt>
        <dd className="min-w-0 truncate">{nome ?? "—"}</dd>

        <dt className="text-xs text-text-muted">{t("Telefone")}</dt>
        <dd className="min-w-0 tabular-nums">
          {contato.phone_number ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {contato.phone_number}
              {digitos && (
                <a
                  href={`https://wa.me/${digitos}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent underline-offset-2 hover:underline"
                >
                  {t("Abrir no WhatsApp")}
                </a>
              )}
            </span>
          ) : (
            "—"
          )}
        </dd>

        <dt className="text-xs text-text-muted">{t("E-mail")}</dt>
        <dd className="min-w-0 truncate">
          {contato.email ? (
            <a href={`mailto:${contato.email}`} className="underline-offset-2 hover:underline">
              {contato.email}
            </a>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <Link
        href={`/app/contacts/${contato.id}`}
        className="inline-block text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {t("Ver ficha completa do contato")}
      </Link>
    </div>
  );
}

/** Os campos personalizados de CONTATO (cadastro central) que valem para este negócio. */
function CamposDoContato({ contato, campos }: { contato: Contact; campos: CustomFieldDef[] }) {
  const t = useT();
  const atualizar = useUpdateContact(contato.id);
  const [valores, setValores] = useState<Record<string, unknown>>(
    () => (contato.custom_fields ?? {}) as Record<string, unknown>,
  );

  async function salvar(e: FormEvent) {
    e.preventDefault();
    try {
      // O PATCH troca o `custom_fields` INTEIRO: mescla com o que já existe
      // (links e campos de outras etapas ficam).
      await atualizar.mutateAsync({
        custom_fields: { ...((contato.custom_fields ?? {}) as Record<string, unknown>), ...valores },
      });
      toast.success(t("Campos atualizados"));
    } catch {
      // `useUpdateContact` já mostra o erro da API.
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-3" data-testid="campos-do-contato">
      <CustomFieldsEditor
        fields={campos}
        value={valores}
        onChange={setValores}
        mode="contact"
        className="gap-3 md:grid-cols-1"
      />
      <Button type="submit" size="sm" disabled={atualizar.isPending}>
        {atualizar.isPending ? t("Salvando…") : t("Salvar")}
      </Button>
    </form>
  );
}

function FormularioDeLinks({ contato, pipelineId }: { contato: Contact; pipelineId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const atualizar = useUpdateContact(contato.id);
  const [valores, setValores] = useState<LinksDoContato>(() => lerLinks(contato.custom_fields));
  // O erro só aparece DEPOIS da primeira tentativa de salvar: "exemplo" ainda
  // sem ".com" não é um erro de quem está no meio da digitação.
  const [tentouSalvar, setTentouSalvar] = useState(false);
  const invalidos = new Set<TipoDeLink>(tiposInvalidos(valores));

  function definir(tipo: TipoDeLink, valor: string) {
    setValores((atual) => ({ ...atual, [tipo]: valor }));
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setTentouSalvar(true);
    if (invalidos.size > 0) {
      toast.error(t("Confira os links marcados: só endereços http(s) valem."));
      return;
    }
    try {
      // O PATCH troca o `custom_fields` INTEIRO — `aplicarLinks` devolve o
      // objeto completo, com os campos que não são link preservados.
      await atualizar.mutateAsync({
        custom_fields: aplicarLinks(contato.custom_fields, valores),
      });
      // O card do funil lê estes links do quadro, não do contato: sem reler o
      // quadro, salvar aqui pareceria "não fez nada" no card.
      await qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
      toast.success(t("Links salvos."));
    } catch {
      // `useUpdateContact` já mostra o erro da API; aqui só não deixar a
      // rejeição escapar como erro não tratado.
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-3" data-testid="formulario-de-links">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TIPOS_DE_LINK.map(({ id, rotulo }) => {
          const href = normalizarLink(valores[id]);
          const erro = tentouSalvar && invalidos.has(id);
          return (
            <div key={id} className="space-y-1">
              <Label htmlFor={`link-${id}`} className="text-xs">
                {t(rotulo)}
              </Label>
              <div className="flex gap-1">
                <Input
                  id={`link-${id}`}
                  value={valores[id] ?? ""}
                  onChange={(e) => definir(id, e.target.value)}
                  maxLength={1000}
                  placeholder={EXEMPLO_DE_LINK}
                  aria-invalid={erro || undefined}
                  className={erro ? "border-destructive" : undefined}
                />
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${t("Abrir")} ${t(rotulo)}`}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-text-muted hover:bg-accent-soft hover:text-accent"
                  >
                    <ArrowSquareOut size={16} aria-hidden />
                  </a>
                )}
              </div>
              {erro && <p className="text-[11px] text-destructive">{t("Endereço inválido.")}</p>}
            </div>
          );
        })}
      </div>
      <Button type="submit" size="sm" disabled={atualizar.isPending}>
        {atualizar.isPending ? t("Salvando…") : t("Salvar links")}
      </Button>
    </form>
  );
}
