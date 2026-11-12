"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ArrowSquareOut } from "@/lib/ui/icons";

interface Anuncio {
  titulo?: string | null;
  corpo?: string | null;
  url?: string | null;
  app?: string | null;
  thumb_url?: string | null;
  thumb_b64?: string | null;
}

/** Lê `metadata.anuncio` (gravado pela ingestão — `cartaoDoAnuncio`); null quando não há. */
export function anuncioDaMensagem(metadata: Record<string, unknown> | null | undefined): Anuncio | null {
  const a = metadata?.anuncio;
  if (!a || typeof a !== "object") return null;
  const o = a as Anuncio;
  return o.titulo || o.url || o.thumb_url || o.thumb_b64 ? o : null;
}

const NOME_DO_APP: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", whatsapp: "WhatsApp" };

/**
 * O anúncio de "Clique para o WhatsApp" no topo da mensagem, como no app: thumb,
 * título, texto e o link para o anúncio. A thumb do CDN do Facebook EXPIRA
 * (parâmetro `oe=`); quando ela falha, cai na miniatura embutida no payload.
 */
export function CartaoDeAnuncio({ anuncio }: { anuncio: Anuncio }) {
  const t = useT();
  const [usarEmbutida, setUsarEmbutida] = useState(!anuncio.thumb_url);
  const src = usarEmbutida
    ? anuncio.thumb_b64
      ? `data:image/png;base64,${anuncio.thumb_b64}`
      : null
    : anuncio.thumb_url;
  const origem = anuncio.app ? (NOME_DO_APP[anuncio.app] ?? anuncio.app) : null;

  const conteudo = (
    <>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- URL externa que expira; next/image exigiria domínio fixo
        <img
          src={src}
          alt=""
          className="h-14 w-14 shrink-0 rounded-md object-cover"
          onError={() => setUsarEmbutida(true)}
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold uppercase tracking-wide opacity-70">
          {origem ? `${t("Anúncio")} · ${origem}` : t("Anúncio")}
        </span>
        {anuncio.titulo ? <span className="line-clamp-2 block font-semibold leading-snug">{anuncio.titulo}</span> : null}
        {anuncio.corpo ? <span className="line-clamp-2 block text-xs opacity-80">{anuncio.corpo}</span> : null}
      </span>
      {anuncio.url ? <ArrowSquareOut size={14} className="shrink-0 self-start opacity-70" aria-hidden /> : null}
    </>
  );

  const classe = "mb-1.5 flex max-w-[300px] items-start gap-2 rounded-lg border border-current/15 bg-background/10 p-2 text-left";

  return anuncio.url ? (
    <a href={anuncio.url} target="_blank" rel="noopener noreferrer" title={t("Ver anúncio")} className={`${classe} hover:bg-background/20`}>
      {conteudo}
    </a>
  ) : (
    <div className={classe}>{conteudo}</div>
  );
}
