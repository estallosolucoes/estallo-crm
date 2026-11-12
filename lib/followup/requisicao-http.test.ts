import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: vi.fn(() => ({ ciphertext: Buffer.from("c"), iv: Buffer.from("i"), tag: Buffer.from("t"), last4: "-123" })),
  decryptKey: vi.fn(() => "segredo-123"),
  bufToBytea: (b: Buffer) => `\\x${b.toString("hex")}`,
  byteaToBuffer: (v: string) => Buffer.from(v.replace(/^\\x/, ""), "hex"),
}));

import { decryptKey } from "@/lib/crypto/aes_gcm";

import {
  corpoDaRequisicao,
  executarRequisicaoHttp,
  falhaDaRequisicao,
  novaConexaoHttpSchema,
  origemDaConexao,
  urlDaRequisicao,
  type PedidoHttp,
} from "./requisicao-http";

const saidas = { m: { pedido: "A/1 ?x", n: 7, obj: { a: 1 } } };

describe("origem da conexão", () => {
  it("aceita só a origem", () => {
    expect(origemDaConexao("https://api.exemplo.com/")).toBe("https://api.exemplo.com");
    expect(origemDaConexao("https://api.exemplo.com:8443")).toBe("https://api.exemplo.com:8443");
    for (const ruim of ["https://api.exemplo.com/v1", "https://u:p@api.exemplo.com", "https://x.com?token=1", "ftp://x.com", "x"])
      expect(origemDaConexao(ruim)).toBeNull();
  });

  it("o cadastro exige credencial quando há autenticação, e usuário:senha no Basic", () => {
    expect(novaConexaoHttpSchema.safeParse({ label: "ERP", base_url: "https://a.com", auth_kind: "bearer" }).success).toBe(false);
    expect(novaConexaoHttpSchema.safeParse({ label: "ERP", base_url: "https://a.com", auth_kind: "basic", segredo: "so" }).success).toBe(false);
    expect(novaConexaoHttpSchema.safeParse({ label: "ERP", base_url: "https://a.com", auth_kind: "header", segredo: "x" }).success).toBe(false);
    expect(novaConexaoHttpSchema.safeParse({ label: "ERP", base_url: "https://a.com", auth_kind: "none" }).success).toBe(true);
  });
});

describe("URL da requisição", () => {
  it("resolve variáveis codificadas dentro da origem", () => {
    expect(urlDaRequisicao("https://a.com", "/pedidos/{{nodes.m.pedido}}", saidas).url).toBe("https://a.com/pedidos/A%2F1%20%3Fx");
  });

  it("nunca sai da origem da conexão (o segredo não vai para outro host)", () => {
    for (const caminho of ["//evil.com/x", "https://evil.com", "evil.com", "/\\evil.com", "\\\\evil.com"])
      expect(urlDaRequisicao("https://a.com", caminho, saidas).url).toBeNull();
  });

  it("variável sem valor ou objeto não vira URL", () => {
    expect(urlDaRequisicao("https://a.com", "/{{nodes.m.nada}}", saidas)).toMatchObject({ url: null, sem_valor: [{ marca: "{{nodes.m.nada}}" }] });
    expect(urlDaRequisicao("https://a.com", "/{{nodes.m.obj}}", saidas).url).toBeNull();
  });
});

describe("corpo da requisição", () => {
  it("substitui dentro dos valores: aspas no valor não injetam campo", () => {
    const r = corpoDaRequisicao('{"nome":"Cliente {{nodes.x.nome}}"}', { x: { nome: '", "admin": true, "a": "' } });
    expect(r.ok && r.corpo).toEqual({ nome: 'Cliente ", "admin": true, "a": "' });
  });

  it("valor que é só a marca mantém o tipo", () => {
    const r = corpoDaRequisicao('{"n":"{{nodes.m.n}}","o":"{{nodes.m.obj}}","l":["{{nodes.m.pedido}}"]}', saidas);
    expect(r.ok && r.corpo).toEqual({ n: 7, o: { a: 1 }, l: ["A/1 ?x"] });
  });

  it("JSON inválido é recusado; vazio é sem corpo", () => {
    expect(corpoDaRequisicao("{x", saidas).ok).toBe(false);
    expect(corpoDaRequisicao("  ", saidas)).toEqual({ ok: true, corpo: undefined, sem_valor: [] });
  });
});

describe("executar a requisição", () => {
  const pedido = (auth: PedidoHttp["conexao"]["auth_kind"] = "bearer"): PedidoHttp => ({
    conexao: { base_url: "https://a.com", auth_kind: auth, header_name: auth === "header" ? "X-Chave" : null, secret_encrypted: "\\x63", secret_iv: "\\x69", secret_tag: "\\x74" },
    metodo: "POST",
    url: "https://a.com/p",
    corpo: { a: 1 },
    chave: "efeito-1",
  });

  beforeEach(() => vi.mocked(decryptKey).mockClear());

  it("2xx: corpo JSON lido, credencial no cabeçalho, chave de idempotência estável", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":9}', { status: 201 }));
    const r = await executarRequisicaoHttp(pedido(), { fetchImpl, pularGuardaDeRede: true });
    expect(r).toEqual({ kind: "resposta", status: 201, corpo: { id: 9 }, truncado: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://a.com/p");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({ Authorization: "Bearer segredo-123", "Idempotency-Key": "efeito-1" });
    expect(init.body).toBe('{"a":1}');
    expect(JSON.stringify(r)).not.toContain("segredo-123");
  });

  it("cabeçalho próprio e Basic", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await executarRequisicaoHttp(pedido("header"), { fetchImpl, pularGuardaDeRede: true });
    await executarRequisicaoHttp(pedido("basic"), { fetchImpl, pularGuardaDeRede: true });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "X-Chave": "segredo-123" });
    expect((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("segredo-123").toString("base64")}`,
    });
  });

  it("resposta acima do teto não vira saída", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(70 * 1024), { status: 200 }));
    expect(await executarRequisicaoHttp(pedido(), { fetchImpl, pularGuardaDeRede: true })).toMatchObject({ corpo: null, truncado: true });
  });

  it("conexão recusada = não saiu; timeout = incerto", async () => {
    const recusada = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await executarRequisicaoHttp(pedido(), { fetchImpl: recusada, pularGuardaDeRede: true })).toEqual({ kind: "nao_saiu", motivo: "ECONNREFUSED", bloqueado: false });
    const lenta = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await executarRequisicaoHttp(pedido(), { fetchImpl: lenta, pularGuardaDeRede: true })).toEqual({ kind: "incerto", motivo: "timeout" });
  });

  it("a guarda de rede recusa destino interno sem abrir rede nem decifrar o segredo", async () => {
    const fetchImpl = vi.fn();
    const r = await executarRequisicaoHttp({ ...pedido(), url: "http://127.0.0.1/x" }, { fetchImpl });
    expect(r).toMatchObject({ kind: "nao_saiu", bloqueado: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decryptKey).not.toHaveBeenCalled();
  });
});

describe("falha no vocabulário do diário", () => {
  it("cada desfecho tem o seu destino", () => {
    expect(falhaDaRequisicao({ kind: "resposta", status: 500, corpo: null, truncado: false })).toMatchObject({ efeito: "failed", erro: { category: "blocked", retryable: false } });
    expect(falhaDaRequisicao({ kind: "incerto", motivo: "timeout" })).toMatchObject({ efeito: "unknown", erro: { category: "unknown", retryable: false } });
    expect(falhaDaRequisicao({ kind: "nao_saiu", motivo: "ECONNREFUSED", bloqueado: false })).toMatchObject({ efeito: "failed", erro: { category: "transient", retryable: true } });
    expect(falhaDaRequisicao({ kind: "nao_saiu", motivo: "unsafe_url:private_host", bloqueado: true })).toMatchObject({ efeito: "failed", erro: { category: "configuration" } });
  });
});
