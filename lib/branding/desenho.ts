/**
 * O DESENHO da marca do produto — símbolo e logotipo — como geometria pura.
 *
 * Mora aqui, e não num `.svg` em `public/`, por duas razões que a doutrina de
 * marca própria já paga:
 *
 *  1. `public/` é servido a todo mundo, sempre. Um arquivo fixo ali seria a
 *     marca do PRODUTO na instalação de um revendedor que configurou a dele —
 *     é exatamente o vazamento que `tests/unit/branding.test.ts` vigia. Como
 *     geometria, o desenho só aparece onde um componente decide que a marca em
 *     vigor é a padrão (`marcaEhADoProduto`, em `lib/branding.ts`).
 *  2. O favicon (`app/icon.tsx`) é gerado em runtime pelo `ImageResponse`, que
 *     aceita SVG inline mas não lê arquivo do disco. Um único desenho alimenta
 *     a tela e o ícone — dois arquivos divergiriam na primeira revisão da marca.
 *
 * As cores NÃO estão aqui de propósito: quem desenha escolhe (a tela lê os
 * tokens do tema; o favicon lê a régua do produto). A fonte deste arquivo são
 * os SVGs em `docs/brand/`; ao trocar a arte, regenere os dois lados a partir
 * deles.
 */

/** Inicial E como geometria: usada na barra recolhida e nos PNGs do aplicativo. */
export const SIMBOLO = {
  viewBox: "0 0 216 216",
  transform: "translate(0 0)",
  d: "M48 30H174V62H84V91H162V123H84V154H174V186H48Z",
  modulo: { x: 0, y: 0, width: 0, height: 0, rx: 0 },
} as const;

export const CORES_DA_MARCA = {
  claro: { simbolo: "#506d48", nome: "#1c1a16", sufixo: "#5d594f" },
  escuro: { simbolo: "#82a077", nome: "#f5f4ef", sufixo: "#8e8b7f" },
} as const;
