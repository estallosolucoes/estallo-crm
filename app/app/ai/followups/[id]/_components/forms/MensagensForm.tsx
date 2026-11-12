"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  actionConfigSchema,
  MAX_ITENS_DO_ENVIO,
  TIPOS_DE_ANEXO,
  type ItemDeEnvio,
  type TipoDeAnexo,
} from "@/lib/followup/graph-schema";
import { TIPOS_DO_ENVIO } from "@/lib/followup/vocabulario";
import { Plus, Trash } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

import { InserirVariavel, inserirNoCursor, PreviaDoTexto } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

type TipoDoItem = "text" | TipoDeAnexo;

const ROTULO_DO_TIPO: Record<TipoDoItem, string> = TIPOS_DO_ENVIO;

/** O que o seletor de arquivo do navegador oferece para cada tipo. */
const ACEITA_POR_TIPO: Record<TipoDeAnexo, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  document:
    ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/pdf,application/msword,text/plain,text/csv,application/zip",
};

type Arquivo = { path: string; mime: string; filename: string; size_bytes: number };

/** O que a tela segura enquanto o envio é montado: o anexo pode ainda não ter arquivo. */
type Rascunho =
  | { chave: string; kind: "text"; body: string }
  | { chave: string; kind: TipoDeAnexo; arquivo: Arquivo | null; caption: string; enviando: boolean };

let contador = 0;
const novaChave = () => `item-${++contador}`;

function deItem(item: ItemDeEnvio): Rascunho {
  if (item.kind === "text") return { chave: novaChave(), kind: "text", body: item.body };
  const { path, mime, filename, size_bytes, caption } = item;
  return {
    chave: novaChave(),
    kind: item.kind,
    arquivo: { path, mime, filename, size_bytes },
    caption: caption ?? "",
    enviando: false,
  };
}

/** Rascunho → item do grafo. `null` enquanto o anexo não tem arquivo. */
function paraItem(r: Rascunho): ItemDeEnvio | null {
  if (r.kind === "text") return { kind: "text", body: r.body };
  if (!r.arquivo) return null;
  return {
    kind: r.kind,
    ...r.arquivo,
    // Áudio não tem legenda no WhatsApp: gravá-la seria um campo que o envio ignora.
    ...(r.kind !== "audio" && r.caption.trim() ? { caption: r.caption } : {}),
  };
}

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function enviarArquivo(file: File): Promise<Arquivo> {
  const corpo = new FormData();
  corpo.append("file", file);
  const resposta = await fetch("/api/v1/ai/followup-flows/media", { method: "POST", body: corpo });
  const json = (await resposta.json().catch(() => null)) as {
    data?: Arquivo;
    error?: { message?: string };
  } | null;
  if (!resposta.ok || !json?.data) throw new Error(json?.error?.message ?? "Não consegui enviar o arquivo.");
  const { path, mime, filename, size_bytes } = json.data;
  return { path, mime, filename, size_bytes };
}

/**
 * Editor do bloco de mensagens: vários envios em sequência — texto, imagem, vídeo, áudio, documento —,
 * no mesmo bloco. O envio sai na ordem da lista; cada um tem o próprio seletor de tipo.
 */
export function MensagensForm({
  items,
  onChange,
}: {
  items: ItemDeEnvio[];
  onChange: (c: ConfigOf<"action">) => void;
}) {
  const t = useT();
  const [lista, setLista] = useState<Rascunho[]>(() =>
    items.length > 0 ? items.map(deItem) : [{ chave: novaChave(), kind: "text", body: "" }],
  );
  const [erro, setErro] = useState<string | null>(null);
  const entradas = useRef<Record<string, HTMLInputElement | null>>({});
  const textos = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // O upload termina depois da renderização que o iniciou: lê a lista de agora, não a do fechamento.
  const atual = useRef(lista);

  const confirmar = (proxima: Rascunho[]) => {
    atual.current = proxima;
    setLista(proxima);
    if (proxima.some((r) => r.kind !== "text" && r.enviando)) return;
    const itens = proxima.map(paraItem);
    if (itens.some((i) => i === null)) {
      setErro(t("Envie o arquivo de cada anexo (ou remova o envio) para salvar o bloco."));
      return;
    }
    const parsed = actionConfigSchema.safeParse({ mode: "messages", items: itens });
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    onChange(parsed.data);
  };

  const trocar = (chave: string, mudanca: (r: Rascunho) => Rascunho) =>
    confirmar(lista.map((r) => (r.chave === chave ? mudanca(r) : r)));

  const trocarTipo = (r: Rascunho, tipo: TipoDoItem): Rascunho => {
    if (tipo === r.kind) return r;
    if (tipo === "text") return { chave: r.chave, kind: "text", body: "" };
    // Entre tipos de anexo o arquivo não sobrevive: o de uma imagem não é um vídeo.
    return { chave: r.chave, kind: tipo, arquivo: null, caption: r.kind === "text" ? "" : r.caption, enviando: false };
  };

  const subir = async (chave: string, file: File) => {
    const marcar = (mudanca: Partial<{ arquivo: Arquivo | null; enviando: boolean }>) =>
      atual.current.map((r) => (r.chave === chave && r.kind !== "text" ? { ...r, ...mudanca } : r));
    confirmar(marcar({ enviando: true }));
    try {
      const arquivo = await enviarArquivo(file);
      confirmar(marcar({ arquivo, enviando: false }));
    } catch (e) {
      confirmar(marcar({ enviando: false }));
      setErro(e instanceof Error ? e.message : t("Não consegui enviar o arquivo."));
    }
  };

  return (
    <div className="space-y-3">
      {lista.map((r, idx) => (
        <div key={r.chave} className="space-y-2 rounded-sm border border-border p-2" data-testid={`envio-${idx}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-muted">
              {idx + 1}. {t(ROTULO_DO_TIPO[r.kind])}
            </span>
            <div className="flex items-center gap-1">
              <Select value={r.kind} onValueChange={(v) => trocar(r.chave, (x) => trocarTipo(x, v as TipoDoItem))}>
                <SelectTrigger aria-label={`${t("Tipo do envio")} ${idx + 1}`} className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["text", ...TIPOS_DE_ANEXO] as TipoDoItem[]).map((tipo) => (
                    <SelectItem key={tipo} value={tipo}>
                      {t(ROTULO_DO_TIPO[tipo])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${t("Remover envio")} ${idx + 1}`}
                disabled={lista.length <= 1}
                onClick={() => confirmar(lista.filter((x) => x.chave !== r.chave))}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
          </div>

          {r.kind === "text" ? (
            <div className="space-y-1">
              <Label htmlFor={`envio-texto-${r.chave}`} className="sr-only">
                {t("Mensagem")}
              </Label>
              <Textarea
                id={`envio-texto-${r.chave}`}
                ref={(el) => {
                  textos.current[r.chave] = el;
                }}
                maxLength={4000}
                placeholder={t("Escreva a mensagem")}
                value={r.body}
                onChange={(e) => trocar(r.chave, (x) => (x.kind === "text" ? { ...x, body: e.target.value } : x))}
              />
              <InserirVariavel
                onInserir={(marca) =>
                  trocar(r.chave, (x) =>
                    x.kind === "text" ? { ...x, body: inserirNoCursor(textos.current[r.chave] ?? null, x.body, marca) } : x,
                  )
                }
              />
              <PreviaDoTexto texto={r.body} />
            </div>
          ) : (
            <div className="space-y-2">
              <input
                ref={(el) => {
                  entradas.current[r.chave] = el;
                }}
                type="file"
                className="hidden"
                accept={ACEITA_POR_TIPO[r.kind]}
                aria-label={`${t("Arquivo do envio")} ${idx + 1}`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void subir(r.chave, file);
                }}
              />
              <div className="flex items-center justify-between gap-2 rounded-sm bg-surface-muted p-2 text-xs">
                <span className="truncate" data-testid={`envio-arquivo-${idx}`}>
                  {r.enviando
                    ? t("Enviando o arquivo…")
                    : r.arquivo
                      ? `${r.arquivo.filename} · ${tamanhoLegivel(r.arquivo.size_bytes)}`
                      : t("Nenhum arquivo escolhido")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={r.enviando}
                  onClick={() => entradas.current[r.chave]?.click()}
                >
                  {r.arquivo ? t("Trocar arquivo") : t("Escolher arquivo")}
                </Button>
              </div>
              {r.kind !== "audio" && (
                <Textarea
                  maxLength={1024}
                  placeholder={t("Legenda (opcional)")}
                  aria-label={`${t("Legenda")} ${idx + 1}`}
                  value={r.caption}
                  onChange={(e) =>
                    trocar(r.chave, (x) => (x.kind !== "text" ? { ...x, caption: e.target.value } : x))
                  }
                />
              )}
            </div>
          )}
        </div>
      ))}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={lista.length >= MAX_ITENS_DO_ENVIO}
        onClick={() => confirmar([...lista, { chave: novaChave(), kind: "text", body: "" }])}
      >
        <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar mensagem")}
      </Button>
      <p className="text-xs text-text-muted">
        {t("Os envios saem na ordem da lista, sem IA. Use {{nome}} no texto e na legenda para chamar a pessoa pelo nome.")}
      </p>
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
    </div>
  );
}
