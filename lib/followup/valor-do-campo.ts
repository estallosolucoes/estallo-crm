/**
 * «Atualizar campo do negócio» (Fase 5): o texto resolvido do bloco → o valor que o campo personalizado guarda,
 * pelo TIPO da definição no catálogo da organização (`custom_field_definitions`). Puro.
 *
 * Nada é "corrigido" em silêncio: opção que não existe na lista, data inexistente, número que não é número —
 * falha com explicação. Texto vazio também falha (apagar um campo não é o que este bloco faz).
 */
import type { TipoDeCampo } from "@/lib/campos/definicao";

export type ValorConvertido = { ok: true; valor: string | number | boolean | string[] } | { ok: false; motivo: string };

interface Definicao {
  key: string;
  label: string;
  type: TipoDeCampo;
  options: Array<{ value: string; label: string }>;
}

const VERDADE = new Set(["sim", "s", "true", "1", "yes"]);
const FALSO = new Set(["não", "nao", "n", "false", "0", "no"]);

function numero(bruto: string): number | null {
  const limpo = bruto.replace(/[R$\s]/g, "");
  const normal = /,\d{1,2}$/.test(limpo) ? limpo.replace(/\./g, "").replace(",", ".") : limpo.replace(/,/g, "");
  const n = Number(normal);
  return normal !== "" && Number.isFinite(n) ? n : null;
}

function data(bruto: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bruto);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(bruto);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  if (!y || !m || !d) return null;
  const c = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (c.getUTCFullYear() !== Number(y) || c.getUTCMonth() !== Number(m) - 1 || c.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

function opcao(def: Definicao, bruto: string): string | null {
  const alvo = bruto.trim().toLowerCase();
  return def.options.find((o) => o.value.toLowerCase() === alvo || o.label.toLowerCase() === alvo)?.value ?? null;
}

export function converterValorDoCampo(def: Definicao, bruto: string): ValorConvertido {
  const t = bruto.trim();
  const erro = (motivo: string): ValorConvertido => ({ ok: false, motivo: `Campo «${def.label}»: ${motivo}` });
  if (t === "") return erro("o valor ficou vazio.");
  switch (def.type) {
    case "number":
    case "currency": {
      const n = numero(t);
      return n === null ? erro(`«${t}» não é um número.`) : { ok: true, valor: n };
    }
    case "date": {
      const d = data(t);
      return d === null ? erro(`«${t}» não é uma data válida (use AAAA-MM-DD ou DD/MM/AAAA).`) : { ok: true, valor: d };
    }
    case "boolean": {
      const s = t.toLowerCase();
      if (VERDADE.has(s)) return { ok: true, valor: true };
      if (FALSO.has(s)) return { ok: true, valor: false };
      return erro(`«${t}» não é sim/não.`);
    }
    case "select": {
      const o = opcao(def, t);
      return o === null ? erro(`«${t}» não é uma das opções da lista.`) : { ok: true, valor: o };
    }
    case "multiselect": {
      const partes = t.split(",").map((p) => p.trim()).filter(Boolean);
      const valores = partes.map((p) => opcao(def, p));
      const fora = partes.filter((_, i) => valores[i] === null);
      return fora.length
        ? erro(`«${fora.join(", ")}» não está entre as opções da lista.`)
        : { ok: true, valor: [...new Set(valores as string[])] };
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? { ok: true, valor: t } : erro(`«${t}» não é um e-mail.`);
    case "url":
      return /^https?:\/\/\S+$/i.test(t) ? { ok: true, valor: t } : erro(`«${t}» não é um endereço http(s).`);
    case "text":
    case "textarea":
    case "phone":
      return { ok: true, valor: t };
  }
}

/** «Valor do negócio» em reais → centavos. */
export function centavosDoValor(bruto: string): number | null {
  const n = numero(bruto.trim());
  return n === null || n < 0 ? null : Math.round(n * 100);
}
