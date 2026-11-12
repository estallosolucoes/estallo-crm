import { Check, Checks, Clock } from "@/lib/ui/icons";

/**
 * Os tiques de entrega, como no WhatsApp: relógio saindo, ✓ enviada, ✓✓
 * entregue, ✓✓ azul lida.
 * Usado na bolha e na prévia da lista. A cor de "lida" vem de `.ibx-ack-read`
 * (`inbox.css`), que muda conforme o fundo — sobre a bolha azul de saída, um
 * azul comum desaparecia (o `text-blue-400` antigo).
 */
export function AckIndicator({ status, t }: { status: string; t: (texto: string) => string }) {
  if (status === "read") {
    return <Checks size={12} weight="bold" className="ibx-ack-read shrink-0" aria-label={t("Lida")} />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="shrink-0 opacity-80" aria-label={t("Entregue")} />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="shrink-0 opacity-80" aria-label={t("Enviada")} />;
  }
  if (status === "queued" || status === "sending") {
    return <Clock size={12} weight="bold" className="shrink-0 opacity-70" aria-label={t("Enviando")} />;
  }
  return null;
}
