"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApagarConexaoHttp, useConexoesHttp, useCriarConexaoHttp } from "@/hooks/followup/useConexoesHttp";
import { useT } from "@/hooks/i18n/useT";
import { METODOS_HTTP } from "@/lib/followup/graph-schema";

import { InserirVariavel, inserirNoCursor } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

type Autenticacao = "none" | "bearer" | "header" | "basic";

/** As conexões da organização: cadastrar (admin) e apagar. A credencial é digitada uma vez e nunca volta à tela. */
function ConexoesHttp() {
  const t = useT();
  const { data: conexoes } = useConexoesHttp();
  const criar = useCriarConexaoHttp();
  const apagar = useApagarConexaoHttp();
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<Autenticacao>("bearer");
  const [cabecalho, setCabecalho] = useState("");
  const [segredo, setSegredo] = useState("");

  return (
    <div className="space-y-4">
      <ul className="space-y-1 text-sm">
        {(conexoes ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {c.label} · <span className="font-mono text-xs">{c.base_url}</span>
              {c.secret_last4 ? <span className="text-text-muted"> · ••••{c.secret_last4}</span> : null}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => apagar.mutate(c.id)}>
              {t("Apagar")}
            </Button>
          </li>
        ))}
        {(conexoes ?? []).length === 0 && <li className="text-text-muted">{t("Nenhuma conexão cadastrada.")}</li>}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          criar.mutate(
            {
              label,
              base_url: baseUrl,
              auth_kind: auth,
              ...(auth === "header" ? { header_name: cabecalho } : {}),
              ...(auth !== "none" ? { segredo } : {}),
            },
            { onSuccess: () => (setLabel(""), setBaseUrl(""), setSegredo("")) },
          );
        }}
      >
        <Label htmlFor="http-con-nome">{t("Nome da conexão")}</Label>
        <Input id="http-con-nome" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        <Label htmlFor="http-con-url">{t("Endereço base")}</Label>
        <Input
          id="http-con-url"
          value={baseUrl}
          placeholder="https://api.exemplo.com"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Label htmlFor="http-con-auth">{t("Autenticação")}</Label>
        <Select value={auth} onValueChange={(v) => setAuth(v as Autenticacao)}>
          <SelectTrigger id="http-con-auth">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">{t("Token (Bearer)")}</SelectItem>
            <SelectItem value="header">{t("Chave num cabeçalho")}</SelectItem>
            <SelectItem value="basic">{t("Usuário e senha (Basic)")}</SelectItem>
            <SelectItem value="none">{t("Sem autenticação")}</SelectItem>
          </SelectContent>
        </Select>
        {auth === "header" && (
          <>
            <Label htmlFor="http-con-cabecalho">{t("Nome do cabeçalho")}</Label>
            <Input
              id="http-con-cabecalho"
              value={cabecalho}
              placeholder="X-Api-Key"
              onChange={(e) => setCabecalho(e.target.value)}
            />
          </>
        )}
        {auth !== "none" && (
          <>
            <Label htmlFor="http-con-segredo">{auth === "basic" ? t("usuário:senha") : t("Credencial")}</Label>
            <Input
              id="http-con-segredo"
              type="password"
              autoComplete="off"
              value={segredo}
              onChange={(e) => setSegredo(e.target.value)}
            />
          </>
        )}
        <p className="text-xs text-text-muted">
          {t("A credencial é guardada cifrada e só é usada para chamar este endereço. Ninguém consegue vê-la depois.")}
        </p>
        <Button type="submit" size="sm" disabled={criar.isPending || !label.trim() || !baseUrl.trim()}>
          {t("Cadastrar conexão")}
        </Button>
      </form>
    </div>
  );
}

/** Requisição HTTP (Fase 5): conexão protegida, método, caminho e corpo JSON com variáveis dos blocos anteriores. */
export function HttpRequestForm({
  config,
  onChange,
}: {
  config: ConfigOf<"http_request">;
  onChange: (c: ConfigOf<"http_request">) => void;
}) {
  const t = useT();
  const { data: conexoes } = useConexoesHttp();
  const caminho = useRef<HTMLInputElement>(null);
  const corpo = useRef<HTMLTextAreaElement>(null);
  const comCorpo = config.metodo !== "GET";
  let corpoInvalido = false;
  if (comCorpo && config.corpo.trim()) {
    try {
      JSON.parse(config.corpo);
    } catch {
      corpoInvalido = true;
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="http-conexao">{t("Conexão")}</Label>
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              {t("Gerenciar conexões")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("Conexões HTTP")}</DialogTitle>
            </DialogHeader>
            <ConexoesHttp />
          </DialogContent>
        </Dialog>
      </div>
      <Select value={config.connection_id || undefined} onValueChange={(v) => onChange({ ...config, connection_id: v })}>
        <SelectTrigger id="http-conexao" aria-invalid={!config.connection_id}>
          <SelectValue placeholder={t("Escolha uma conexão")} />
        </SelectTrigger>
        <SelectContent>
          {(conexoes ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Label htmlFor="http-metodo">{t("Método")}</Label>
      <Select
        value={config.metodo}
        onValueChange={(v) => onChange({ ...config, metodo: METODOS_HTTP.find((m) => m === v) ?? "GET" })}
      >
        <SelectTrigger id="http-metodo">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* Literais por ramo (cerca de i18n): os rótulos são os de `METODOS_HTTP_ROTULOS` (vocabulario.ts). */}
          <SelectItem value="GET">{t("GET — consultar")}</SelectItem>
          <SelectItem value="POST">{t("POST — criar ou enviar")}</SelectItem>
          <SelectItem value="PUT">{t("PUT — substituir")}</SelectItem>
          <SelectItem value="PATCH">{t("PATCH — alterar parte")}</SelectItem>
          <SelectItem value="DELETE">{t("DELETE — apagar")}</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="http-caminho">{t("Caminho")}</Label>
        <InserirVariavel
          soBlocos
          onInserir={(marca) => onChange({ ...config, caminho: inserirNoCursor(caminho.current, config.caminho, marca) })}
        />
      </div>
      <Input
        id="http-caminho"
        ref={caminho}
        value={config.caminho}
        maxLength={2000}
        placeholder="/v1/pedidos"
        className="font-mono"
        onChange={(e) => onChange({ ...config, caminho: e.target.value })}
      />
      {comCorpo && (
        <>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="http-corpo">{t("Corpo (JSON)")}</Label>
            <InserirVariavel
              soBlocos
              onInserir={(marca) => onChange({ ...config, corpo: inserirNoCursor(corpo.current, config.corpo, marca) })}
            />
          </div>
          <Textarea
            id="http-corpo"
            ref={corpo}
            value={config.corpo}
            maxLength={20_000}
            rows={6}
            className="font-mono text-xs"
            aria-invalid={corpoInvalido}
            onChange={(e) => onChange({ ...config, corpo: e.target.value })}
          />
          {corpoInvalido && <p className="text-xs text-error-fg">{t("O corpo não é um JSON válido.")}</p>}
        </>
      )}
      <p className="text-xs text-text-muted">
        {t("Só respostas 2xx seguem pelo caminho normal. Se a resposta não chegar, a execução para para revisão e nada é reenviado sozinho.")}
      </p>
    </div>
  );
}
