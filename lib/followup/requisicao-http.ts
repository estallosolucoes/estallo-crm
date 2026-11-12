/**
 * Bloco "Requisição HTTP" (Fase 5) — a parte pura e a chamada de rede, separadas do diário.
 *
 * Segurança, nesta ordem:
 *  1. O segredo nunca está no fluxo: o bloco cita uma CONEXÃO (`automation_http_connections`), e a credencial é
 *     decifrada só aqui, no servidor, no instante da chamada. Nada dela entra em snapshot, evento ou saída.
 *  2. A chamada só vai para a ORIGEM da conexão: o caminho é resolvido contra ela e a origem tem de continuar igual
 *     (`//outro.host`, `https://…` e `\\` no caminho são recusados). Editar o fluxo não leva o segredo a outro lugar.
 *  3. As proteções de saída de sempre (as do `call_webhook`): guarda textual + IP resolvido (anti-SSRF), sem seguir
 *     redirecionamento, timeout de 10 s e teto de resposta.
 *  4. Variáveis no corpo são substituídas DENTRO dos valores do JSON, nunca no texto cru: um valor com aspas não
 *     consegue fechar a string e injetar campo. Um valor que é só a marca (`"{{nodes.x.y}}"`) mantém o tipo.
 */
import { z } from "zod";

import type { ExecutionError } from "./execution-contract";

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

import { extrairReferencias, ler, MARCA_DE_BLOCO, resolverReferencias, type ReferenciaDeBloco } from "./variaveis-de-blocos";

import type { METODOS_HTTP } from "./graph-schema";
export type MetodoHttp = (typeof METODOS_HTTP)[number];

export const TIPOS_DE_AUTENTICACAO = ["none", "bearer", "header", "basic"] as const;
export type TipoDeAutenticacao = (typeof TIPOS_DE_AUTENTICACAO)[number];

export const TIMEOUT_DA_REQUISICAO_MS = 10_000;
/** Teto do corpo da resposta lido e guardado como saída (a saída mora no diário da execução). */
export const TETO_DA_RESPOSTA_BYTES = 64 * 1024;

/** Só a origem: `https://host[:porta]`, sem caminho, credencial, query ou fragmento. */
export function origemDaConexao(bruto: string): string | null {
  let url: URL;
  try {
    url = new URL(bruto.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export const novaConexaoHttpSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(80),
    base_url: z.string().max(300),
    auth_kind: z.enum(TIPOS_DE_AUTENTICACAO),
    header_name: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .optional(),
    segredo: z.string().max(4000).optional(),
  })
  .superRefine((v, ctx) => {
    if (!origemDaConexao(v.base_url))
      ctx.addIssue({ code: "custom", path: ["base_url"], message: "Informe só o endereço base, como https://api.exemplo.com" });
    if (v.auth_kind === "header" && !v.header_name)
      ctx.addIssue({ code: "custom", path: ["header_name"], message: "Informe o nome do cabeçalho." });
    if (v.auth_kind !== "none" && !v.segredo?.trim())
      ctx.addIssue({ code: "custom", path: ["segredo"], message: "Informe a credencial." });
    if (v.auth_kind === "basic" && v.segredo && !v.segredo.includes(":"))
      ctx.addIssue({ code: "custom", path: ["segredo"], message: "Use usuário:senha." });
  });
export type NovaConexaoHttp = z.infer<typeof novaConexaoHttpSchema>;

/** As colunas cifradas de uma conexão nova (AES-256-GCM, chave da instalação). */
export function colunasDoSegredo(auth: TipoDeAutenticacao, segredo: string | undefined) {
  if (auth === "none" || !segredo)
    return { secret_encrypted: null, secret_iv: null, secret_tag: null, secret_last4: null };
  const e = encryptKey(segredo.trim());
  return {
    secret_encrypted: bufToBytea(e.ciphertext),
    secret_iv: bufToBytea(e.iv),
    secret_tag: bufToBytea(e.tag),
    secret_last4: e.last4,
  };
}

/** O que o diário entrega para a chamada: a conexão como está no banco (cifrada) e o pedido resolvido. */
export interface PedidoHttp {
  conexao: {
    base_url: string;
    auth_kind: TipoDeAutenticacao;
    header_name: string | null;
    secret_encrypted: unknown;
    secret_iv: unknown;
    secret_tag: unknown;
  };
  metodo: MetodoHttp;
  url: string;
  corpo: unknown;
  /** Identidade do efeito — vai como `Idempotency-Key`, a mesma em toda nova tentativa do mesmo passo. */
  chave: string;
}

/** O caminho, com as variáveis resolvidas (codificadas), contra a origem da conexão. `null` se sair da origem. */
export function urlDaRequisicao(
  baseUrl: string,
  caminho: string,
  saidas: Record<string, unknown>,
): { url: string; sem_valor: ReferenciaDeBloco[] } | { url: null; sem_valor: ReferenciaDeBloco[] } {
  const semValor: ReferenciaDeBloco[] = [];
  const resolvido = caminho.replace(new RegExp(MARCA_DE_BLOCO.source, "g"), (marca, noId: string, campo: string) => {
    const valor = Object.prototype.hasOwnProperty.call(saidas, noId) ? ler(saidas[noId], campo) : undefined;
    if (valor === undefined || valor === null || typeof valor === "object") {
      semValor.push({ marca, no_id: noId, caminho: campo });
      return "";
    }
    return encodeURIComponent(String(valor));
  });
  if (semValor.length > 0) return { url: null, sem_valor: semValor };
  const limpo = resolvido.trim() || "/";
  if (!limpo.startsWith("/") || limpo.startsWith("//") || limpo.includes("\\")) return { url: null, sem_valor: [] };
  const origem = origemDaConexao(baseUrl);
  if (!origem) return { url: null, sem_valor: [] };
  const url = new URL(limpo, origem);
  if (url.origin !== origem) return { url: null, sem_valor: [] };
  return { url: url.toString(), sem_valor: [] };
}

/** O corpo JSON com as variáveis substituídas dentro dos valores. Texto vazio = sem corpo. */
export function corpoDaRequisicao(
  corpo: string,
  saidas: Record<string, unknown>,
): { ok: true; corpo: unknown; sem_valor: ReferenciaDeBloco[] } | { ok: false; motivo: string } {
  if (!corpo.trim()) return { ok: true, corpo: undefined, sem_valor: [] };
  let modelo: unknown;
  try {
    modelo = JSON.parse(corpo);
  } catch {
    return { ok: false, motivo: "O corpo da requisição não é um JSON válido." };
  }
  const semValor: ReferenciaDeBloco[] = [];
  const marcaInteira = new RegExp(`^${MARCA_DE_BLOCO.source}$`);
  const andar = (v: unknown): unknown => {
    if (typeof v === "string") {
      const inteira = v.trim().match(marcaInteira);
      if (inteira) {
        const valor = Object.prototype.hasOwnProperty.call(saidas, inteira[1]!) ? ler(saidas[inteira[1]!], inteira[2]!) : undefined;
        if (valor === undefined) semValor.push({ marca: inteira[0], no_id: inteira[1]!, caminho: inteira[2]! });
        return valor ?? null;
      }
      if (extrairReferencias(v).length === 0) return v;
      const r = resolverReferencias(v, saidas);
      semValor.push(...r.sem_valor);
      return r.texto;
    }
    if (Array.isArray(v)) return v.map(andar);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, andar(x)]));
    return v;
  };
  return { ok: true, corpo: andar(modelo), sem_valor: semValor };
}

/**
 * - `resposta`: o servidor respondeu (qualquer status). Só 2xx conta como sucesso do bloco.
 * - `nao_saiu`: a requisição comprovadamente não saiu (destino recusado, DNS, conexão recusada) — pode tentar de novo.
 * - `incerto`: pode ter chegado (timeout, conexão cortada no meio). NUNCA se repete sozinho: vai para revisão.
 */
export type ResultadoHttp =
  | { kind: "resposta"; status: number; corpo: unknown; truncado: boolean }
  | { kind: "nao_saiu"; motivo: string; bloqueado: boolean }
  | { kind: "incerto"; motivo: string };

const ERROS_ANTES_DE_ENVIAR = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function cabecalhoDeAutenticacao(conexao: PedidoHttp["conexao"]): Record<string, string> {
  if (conexao.auth_kind === "none") return {};
  const segredo = decryptKey({
    ciphertext: byteaToBuffer(conexao.secret_encrypted),
    iv: byteaToBuffer(conexao.secret_iv),
    tag: byteaToBuffer(conexao.secret_tag),
  });
  if (conexao.auth_kind === "bearer") return { Authorization: `Bearer ${segredo}` };
  if (conexao.auth_kind === "basic") return { Authorization: `Basic ${Buffer.from(segredo).toString("base64")}` };
  return { [conexao.header_name ?? "X-Api-Key"]: segredo };
}

async function lerCorpo(res: Response): Promise<{ texto: string; truncado: boolean }> {
  if (!res.body) return { texto: "", truncado: false };
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  let truncado = false;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > TETO_DA_RESPOSTA_BYTES) {
      truncado = true;
      await leitor.cancel();
      break;
    }
    partes.push(value);
  }
  return { texto: Buffer.concat(partes).toString("utf8"), truncado };
}

export async function executarRequisicaoHttp(
  pedido: PedidoHttp,
  opts: { fetchImpl?: typeof fetch; pularGuardaDeRede?: boolean } = {},
): Promise<ResultadoHttp> {
  if (!opts.pularGuardaDeRede) {
    try {
      assertSafeOutboundUrl(pedido.url);
      await assertDestinoResolvidoSeguro(new URL(pedido.url).hostname);
    } catch (e) {
      const motivo = (e as Error).message;
      return { kind: "nao_saiu", motivo, bloqueado: !motivo.startsWith("unsafe_url:dns") };
    }
  }
  let autenticacao: Record<string, string>;
  try {
    autenticacao = cabecalhoDeAutenticacao(pedido.conexao);
  } catch {
    return { kind: "nao_saiu", motivo: "credencial_indisponivel", bloqueado: true };
  }
  const comCorpo = pedido.corpo !== undefined && pedido.metodo !== "GET";
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(pedido.url, {
      method: pedido.metodo,
      headers: {
        Accept: "application/json",
        "Idempotency-Key": pedido.chave,
        ...(comCorpo ? { "Content-Type": "application/json" } : {}),
        ...autenticacao,
      },
      ...(comCorpo ? { body: JSON.stringify(pedido.corpo) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_DA_REQUISICAO_MS),
    });
  } catch (e) {
    const codigo = (e as { cause?: { code?: string } }).cause?.code;
    if (codigo && ERROS_ANTES_DE_ENVIAR.has(codigo)) return { kind: "nao_saiu", motivo: codigo, bloqueado: false };
    const nome = (e as Error).name;
    return { kind: "incerto", motivo: nome === "TimeoutError" || nome === "AbortError" ? "timeout" : (codigo ?? nome ?? "erro") };
  }
  const { texto, truncado } = await lerCorpo(res).catch(() => ({ texto: "", truncado: true }));
  let corpo: unknown = texto;
  if (!truncado && texto) {
    try {
      corpo = JSON.parse(texto);
    } catch {
      corpo = texto;
    }
  }
  return { kind: "resposta", status: res.status, corpo: truncado ? null : corpo, truncado };
}

/**
 * O resultado que não é 2xx, no vocabulário do diário. `failed` = a intenção não virou efeito (não saiu, ou o sistema
 * respondeu e recusou); `unknown` = pode ter chegado — a execução para e a Central decide, nunca reenvio automático.
 */
export function falhaDaRequisicao(r: Exclude<ResultadoHttp, { kind: "resposta" }> | Extract<ResultadoHttp, { kind: "resposta" }>): {
  efeito: "failed" | "unknown";
  erro: ExecutionError;
} {
  if (r.kind === "resposta")
    return {
      efeito: "failed",
      erro: {
        code: "http_status_nao_aceito",
        message: `O sistema externo respondeu com o status ${r.status}.`,
        category: "blocked",
        retryable: false,
        details: { status: r.status },
      },
    };
  if (r.kind === "incerto")
    return {
      efeito: "unknown",
      erro: {
        code: "http_resultado_incerto",
        message: `A requisição pode ter chegado ao sistema externo (${r.motivo}). Confira lá antes de tentar de novo.`,
        category: "unknown",
        retryable: false,
      },
    };
  if (r.bloqueado)
    return {
      efeito: "failed",
      erro: {
        code: "http_destino_recusado",
        message:
          r.motivo === "credencial_indisponivel"
            ? "A credencial da conexão não pôde ser aberta nesta instalação (chave de cifra ausente ou trocada)."
            : "O endereço da conexão não é um destino permitido (rede interna, endereço inválido ou http sem https).",
        category: "configuration",
        retryable: false,
      },
    };
  return {
    efeito: "failed",
    erro: {
      code: "http_nao_saiu",
      message: `O sistema externo não aceitou a conexão (${r.motivo}). A requisição não saiu; uma nova tentativa será feita.`,
      category: "transient",
      retryable: true,
    },
  };
}
