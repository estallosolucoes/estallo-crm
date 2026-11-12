"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { parseDialablePhone, resolveSharedContacts, type SharedContact } from "@/lib/messaging/contact-card";
import type { Message } from "@/lib/types/messaging";
import { UserCircle } from "@/lib/ui/icons";

interface Props {
  message: Message;
}

/**
 * Cartão(ões) de contato compartilhado. O WhatsApp deixa enviar VÁRIOS contatos
 * numa mensagem só; cada um vira uma linha com "Enviar mensagem" (abre a conversa
 * na mesma sessão) e "Salvar contato" (cria o contato no CRM).
 */
export function ContactCard({ message }: Props) {
  const t = useT();
  const contatos = resolveSharedContacts(message);

  if (contatos.length === 0) {
    return (
      <div className="rounded-lg border border-current/20 bg-background/10 px-3 py-2 text-xs opacity-80">
        {t("Contato")}
      </div>
    );
  }

  return (
    <div className="flex max-w-[260px] flex-col gap-1.5">
      {contatos.map((c, i) => (
        <LinhaDeContato key={`${c.phone_number}-${i}`} contato={c} channelSessionId={message.channel_session_id} />
      ))}
    </div>
  );
}

function LinhaDeContato({ contato, channelSessionId }: { contato: SharedContact; channelSessionId: string }) {
  const t = useT();
  const router = useRouter();
  const [ocupado, setOcupado] = useState<"abrir" | "salvar" | null>(null);
  const [salvo, setSalvo] = useState(false);
  const telefone = contato.phone_number?.trim() ?? "";
  const podeAbrir = !!(contato.contact_id || telefone);
  const e164 = telefone ? parseDialablePhone(telefone) : null;
  const podeSalvar = !contato.contact_id && !!e164 && !salvo;

  async function abrir() {
    if (!podeAbrir || ocupado) return;
    setOcupado("abrir");
    try {
      const res = await apiClient.post<{ data: { conversation_id: string } }>(
        "/api/v1/conversations/open-with-contact",
        {
          channel_session_id: channelSessionId,
          contact_id: contato.contact_id,
          phone_number: telefone || undefined,
          name: contato.name,
        },
      );
      router.push(`/app/inbox?id=${res.data.conversation_id}`);
    } catch (err) {
      showApiError(err);
    } finally {
      setOcupado(null);
    }
  }

  async function salvar() {
    if (!podeSalvar || ocupado) return;
    setOcupado("salvar");
    try {
      await apiClient.post("/api/v1/contacts", {
        display_name: contato.name,
        phone_number: e164!.replace(/[^\d+]/g, ""),
        source: "contato_compartilhado",
      });
      setSalvo(true);
      toast.success(t("Contato salvo."));
    } catch (err) {
      showApiError(err);
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="rounded-lg border border-current/20 bg-background/10 p-2">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background/20">
          <UserCircle size={26} weight="duotone" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-medium">{contato.name}</span>
          {telefone ? <span className="block truncate text-xs opacity-80">{phoneForDisplay(telefone)}</span> : null}
        </span>
      </div>
      <div className="mt-2 flex gap-1.5 border-t border-current/15 pt-2 text-xs font-medium">
        <button
          type="button"
          onClick={abrir}
          disabled={!podeAbrir || ocupado !== null}
          className="flex-1 rounded-md px-2 py-1 hover:bg-background/20 disabled:opacity-60"
        >
          {ocupado === "abrir" ? t("Abrindo…") : t("Enviar mensagem")}
        </button>
        {podeSalvar || salvo ? (
          <button
            type="button"
            onClick={salvar}
            disabled={!podeSalvar || ocupado !== null}
            className="flex-1 rounded-md px-2 py-1 hover:bg-background/20 disabled:opacity-60"
          >
            {salvo ? t("Salvo") : ocupado === "salvar" ? t("Salvando…") : t("Salvar contato")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
