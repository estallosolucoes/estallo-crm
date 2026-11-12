import { Fragment, type ReactNode } from "react";

/**
 * A FORMATAÇÃO DO WHATSAPP, NUM LUGAR SÓ.
 *
 * O texto guardado no banco é o que o WhatsApp transporta — `*negrito*`,
 * `_itálico_`, `~tachado~`, ```` ```mono``` ````, `` `código` ``, `> citação`,
 * listas com `- `/`* ` e `1. `. Antes daqui o chat mostrava os asteriscos
 * literalmente. Esta é a ÚNICA leitura dessa sintaxe na interface: a bolha, as
 * prévias e as respostas rápidas chamam o mesmo componente.
 *
 * Três regras que separam isto de um Markdown qualquer:
 *  - O marcador só abre em BORDA DE PALAVRA (início, espaço ou pontuação antes)
 *    seguido de não-espaço, e só fecha depois de não-espaço com borda depois.
 *    É o que impede `2*3*4` e `snake_case_var` de virarem estilo.
 *  - Nenhum estilo atravessa a quebra de linha (o ``` é a exceção, como lá).
 *  - URL é token atômico: o `_` de um link não vira itálico.
 *
 * Saída em nós React, nunca HTML: o texto do cliente não tem como injetar
 * marcação — `<script>` aparece como texto. O conteúdo do banco não muda.
 */

export type NoInline =
  | string
  | { tipo: "negrito" | "italico" | "tachado"; filhos: NoInline[] }
  | { tipo: "codigo" | "mono"; texto: string }
  | { tipo: "link"; href: string; texto: string };

export type Bloco =
  | { tipo: "texto"; linhas: NoInline[][] }
  | { tipo: "citacao"; linhas: NoInline[][] }
  | { tipo: "lista"; ordenada: boolean; itens: NoInline[][] }
  | { tipo: "mono"; texto: string };

const ESTILO = { "*": "negrito", _: "italico", "~": "tachado" } as const;
type Marcador = keyof typeof ESTILO;

const PALAVRA = /[\p{L}\p{N}]/u;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,;:!?)\]'"]/giu;

const ehPalavra = (c: string | undefined) => c !== undefined && PALAVRA.test(c);
const ehEspaco = (c: string | undefined) => c === undefined || /\s/.test(c);

/** Acha o fechamento do marcador aberto em `i`, ou -1. */
function fechamento(s: string, i: number, m: Marcador): number {
  for (let j = i + 2; j < s.length; j++) {
    const c = s[j];
    if (c === "\n") return -1;
    if (c === m && !ehEspaco(s[j - 1]) && !ehPalavra(s[j + 1])) return j;
  }
  return -1;
}

function estilos(s: string): NoInline[] {
  const saida: NoInline[] = [];
  let texto = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "*" || c === "_" || c === "~") {
      const abre = !ehPalavra(s[i - 1]) && !ehEspaco(s[i + 1]) && s[i + 1] !== c;
      const j = abre ? fechamento(s, i, c) : -1;
      if (j > i + 1) {
        if (texto) saida.push(texto);
        texto = "";
        saida.push({ tipo: ESTILO[c], filhos: estilos(s.slice(i + 1, j)) });
        i = j + 1;
        continue;
      }
    }
    texto += c;
    i++;
  }
  if (texto) saida.push(texto);
  return saida;
}

/** Código (```mono``` e `inline`) e links primeiro — o que está dentro deles é literal. */
export function analisarInline(s: string, comLinks = true): NoInline[] {
  const saida: NoInline[] = [];
  const atomicos = new RegExp(`\`\`\`([\\s\\S]+?)\`\`\`|\`([^\`\\n]+)\`${comLinks ? `|${URL.source}` : ""}`, "giu");
  let ultimo = 0;
  for (const m of s.matchAll(atomicos)) {
    const inicio = m.index ?? 0;
    if (inicio > ultimo) saida.push(...estilos(s.slice(ultimo, inicio)));
    if (m[1] !== undefined) saida.push({ tipo: "mono", texto: m[1] });
    else if (m[2] !== undefined) saida.push({ tipo: "codigo", texto: m[2] });
    else {
      const href = m[0].toLowerCase().startsWith("www.") ? `https://${m[0]}` : m[0];
      saida.push({ tipo: "link", href, texto: m[0] });
    }
    ultimo = inicio + m[0].length;
  }
  if (ultimo < s.length) saida.push(...estilos(s.slice(ultimo)));
  return saida;
}

const CITACAO = /^>\s?(.*)$/;
const MARCADOR = /^[-*•]\s+(.*)$/;
const NUMERO = /^\d+[.)]\s+(.*)$/;

export function analisarBlocos(texto: string): Bloco[] {
  const blocos: Bloco[] = [];
  // O ``` pode atravessar linhas: separa antes de quebrar por linha.
  const partes = texto.split(/```([\s\S]+?)```/);
  partes.forEach((parte, k) => {
    if (k % 2 === 1) {
      blocos.push({ tipo: "mono", texto: parte.replace(/^\n/, "").replace(/\n$/, "") });
      return;
    }
    const linhas = parte.split("\n");
    for (const linha of linhas) {
      const ultimo = blocos[blocos.length - 1];
      let m: RegExpMatchArray | null;
      if ((m = linha.match(CITACAO))) {
        const conteudo = analisarInline(m[1] ?? "");
        if (ultimo?.tipo === "citacao") ultimo.linhas.push(conteudo);
        else blocos.push({ tipo: "citacao", linhas: [conteudo] });
      } else if ((m = linha.match(MARCADOR)) || (m = linha.match(NUMERO))) {
        const ordenada = NUMERO.test(linha);
        const conteudo = analisarInline(m[1] ?? "");
        if (ultimo?.tipo === "lista" && ultimo.ordenada === ordenada) ultimo.itens.push(conteudo);
        else blocos.push({ tipo: "lista", ordenada, itens: [conteudo] });
      } else if (ultimo?.tipo === "texto") {
        ultimo.linhas.push(analisarInline(linha));
      } else {
        blocos.push({ tipo: "texto", linhas: [analisarInline(linha)] });
      }
    }
  });
  // Uma quebra de linha logo antes/depois do ``` não vira linha em branco.
  return blocos.filter(
    (b, i) =>
      !(b.tipo === "texto" && b.linhas.length === 1 && b.linhas[0]!.length === 0 &&
        (blocos[i - 1]?.tipo === "mono" || blocos[i + 1]?.tipo === "mono")),
  );
}

function renderInline(nos: NoInline[], chave: string): ReactNode[] {
  return nos.map((no, i) => {
    const k = `${chave}.${i}`;
    if (typeof no === "string") return <Fragment key={k}>{no}</Fragment>;
    switch (no.tipo) {
      case "negrito":
        return <strong key={k} className="font-bold">{renderInline(no.filhos, k)}</strong>;
      case "italico":
        return <em key={k}>{renderInline(no.filhos, k)}</em>;
      case "tachado":
        return <s key={k}>{renderInline(no.filhos, k)}</s>;
      case "codigo":
        return (
          <code key={k} className="rounded-sm bg-current/10 px-1 font-mono text-[0.92em]">
            {no.texto}
          </code>
        );
      case "mono":
        return <code key={k} className="font-mono text-[0.92em]">{no.texto}</code>;
      case "link":
        return (
          <a
            key={k}
            href={no.href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all underline underline-offset-2"
          >
            {no.texto}
          </a>
        );
    }
  });
}

function linhasComQuebra(linhas: NoInline[][], chave: string): ReactNode[] {
  return linhas.flatMap((l, i) => [
    ...(i > 0 ? [<Fragment key={`${chave}.br${i}`}>{"\n"}</Fragment>] : []),
    ...renderInline(l, `${chave}.${i}`),
  ]);
}

interface Props {
  texto: string;
  /**
   * `bloco` — a bolha: citações, listas e ``` como blocos, links clicáveis.
   * `linha` — prévias (lista de conversas, respostas rápidas): só os estilos
   * inline, numa linha; sem link (a prévia já é um elemento clicável).
   */
  modo?: "bloco" | "linha";
}

export function FormatacaoWhatsApp({ texto, modo = "bloco" }: Props) {
  if (modo === "linha") {
    const corrido = texto
      .split("\n")
      .map((l) => l.replace(CITACAO, "$1").replace(MARCADOR, "• $1"))
      .join(" ");
    return <>{renderInline(analisarInline(corrido, false), "l")}</>;
  }
  return (
    <>
      {analisarBlocos(texto).map((b, i) => {
        const k = `b${i}`;
        switch (b.tipo) {
          case "texto":
            return <Fragment key={k}>{linhasComQuebra(b.linhas, k)}</Fragment>;
          case "citacao":
            return (
              <blockquote key={k} className="my-0.5 border-l-[3px] border-current/30 pl-2 opacity-80">
                {linhasComQuebra(b.linhas, k)}
              </blockquote>
            );
          case "lista": {
            const Lista = b.ordenada ? "ol" : "ul";
            return (
              <Lista key={k} className={b.ordenada ? "my-0.5 list-decimal pl-5" : "my-0.5 list-disc pl-5"}>
                {b.itens.map((item, j) => (
                  <li key={j}>{renderInline(item, `${k}.${j}`)}</li>
                ))}
              </Lista>
            );
          }
          case "mono":
            return (
              <code key={k} className="block font-mono text-[0.92em]">
                {b.texto}
              </code>
            );
        }
      })}
    </>
  );
}
