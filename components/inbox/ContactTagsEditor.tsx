"use client";
import { useT } from "@/hooks/i18n/useT";
import { SeletorDeTags } from "@/components/tags/SeletorDeTags";
import { normalizarTag } from "@/lib/contacts/tag-normalizada";

interface Props {
  tags: string[];
  /** Grava a lista nova — otimista, via `useTagsDoContato` de quem monta. */
  onChange: (proximas: string[]) => void;
}

/**
 * Edita as tags do CONTATO — aberto pelo botão "Tags do contato" do painel do
 * Inbox. Oferece as etiquetas cadastradas de contato (tela Tags, /app/crm/tags)
 * e permite criar na hora. Grava a cada mudança, sem travar o campo: quem monta
 * (`CRMSidePanel`) aplica na tela antes da resposta e desfaz se der erro.
 *
 * A forma gravada é a normalizada (`normalizarTag`), a mesma do servidor: sem
 * isso "VIP" e "vip" virariam duas etiquetas no mesmo contato.
 */
export function ContactTagsEditor({ tags, onChange }: Props) {
  const t = useT();

  return (
    <div className="mt-2 rounded-md border border-border p-2">
      <SeletorDeTags
        entidade="contact"
        valor={tags}
        onChange={onChange}
        normalizar={normalizarTag}
        rotulo={t("Adicionar tag ao contato")}
      />
      {tags.length === 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">{t("Sem tags no contato.")}</p>
      )}
    </div>
  );
}
