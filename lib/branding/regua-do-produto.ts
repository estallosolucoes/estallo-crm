/** Gerado por extrairRegua(app/globals.css); conferido por branding-regua-do-produto.test.ts. */
import type { Regua } from "./contraste";
export const REGUA_DO_PRODUTO: Regua = {
  rampaDoProduto: [
    "#e7f5fc",
    "#d9effa",
    "#b3e0f3",
    "#8fd9f5",
    "#54bce8",
    "#1099d3",
    "#0b6e9a",
    "#095a7f",
    "#084866",
    "#07384f",
    "#051e2b",
  ],
  claro: {
    nome: "claro",
    base: [
      {
        chave: "--color-bg",
        hex: "#f8fafb",
      },
      {
        chave: "--color-surface",
        hex: "#ffffff",
      },
      {
        chave: "--color-surface-elevated",
        hex: "#f1f4f6",
      },
    ],
    tingidas: [
      {
        chave: "--color-accent-soft",
        fonte: {
          tipo: "grau",
          indice: 1,
          alfa: 1,
        },
      },
    ],
    papeis: [
      {
        token: "--color-accent",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 6,
          alfa: 1,
        },
        contra: null,
      },
      {
        token: "--color-accent-fg",
        tipo: "texto",
        fonte: {
          tipo: "frenteCalculada",
          sobre: {
            tipo: "grau",
            indice: 6,
            alfa: 1,
          },
        },
        contra: [
          {
            tipo: "grau",
            indice: 6,
            alfa: 1,
          },
        ],
      },
      {
        token: "--color-accent-hover",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 7,
          alfa: 1,
        },
        contra: null,
      },
      {
        token: "--ring",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 6,
          alfa: 1,
        },
        contra: null,
      },
      {
        token: "::selection/color",
        tipo: "texto",
        fonte: {
          tipo: "grau",
          indice: 10,
          alfa: 1,
        },
        contra: [
          {
            tipo: "grau",
            indice: 2,
            alfa: 1,
          },
        ],
      },
      {
        token: ":focus-visible/outline",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 6,
          alfa: 1,
        },
        contra: null,
      },
    ],
    semanticas: [
      {
        nome: "success",
        hex: "#087653",
      },
      {
        nome: "warning",
        hex: "#895800",
      },
      {
        nome: "error",
        hex: "#bc3038",
      },
      {
        nome: "info",
        hex: "#0b6e9a",
      },
    ],
    neutros: [
      "#f8fafb",
      "#f1f4f6",
      "#e2e7eb",
      "#c4cdd4",
      "#92a0ab",
      "#647480",
      "#536573",
      "#3e4e5a",
      "#34424e",
      "#26333d",
      "#17232c",
    ],
    indices: {
      accent: 6,
      hover: 7,
      soft: 1,
    },
    alfaDoSoft: 1,
  },
  escuro: {
    nome: "escuro",
    base: [
      {
        chave: "--color-bg",
        hex: "#17232c",
      },
      {
        chave: "--color-surface",
        hex: "#26333d",
      },
      {
        chave: "--color-surface-elevated",
        hex: "#34424e",
      },
    ],
    tingidas: [
      {
        chave: "--color-accent-soft",
        fonte: {
          tipo: "literal",
          hex: "#54bce8",
          alfa: 0.16,
        },
      },
    ],
    papeis: [
      {
        token: "--color-accent",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 7,
          alfa: 1,
        },
        contra: null,
      },
      {
        token: "--color-accent-fg",
        tipo: "texto",
        fonte: {
          tipo: "frenteCalculada",
          sobre: {
            tipo: "grau",
            indice: 7,
            alfa: 1,
          },
        },
        contra: [
          {
            tipo: "grau",
            indice: 7,
            alfa: 1,
          },
        ],
      },
      {
        token: "--color-accent-hover",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 8,
          alfa: 1,
        },
        contra: null,
      },
      {
        token: "--ring",
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 4,
          alfa: 1,
        },
        contra: null,
      },
      {
        token: '[data-theme="dark"] ::selection/color',
        tipo: "texto",
        fonte: {
          tipo: "grau",
          indice: 0,
          alfa: 1,
        },
        contra: [
          {
            tipo: "grau",
            indice: 7,
            alfa: 1,
          },
        ],
      },
      {
        token: '[data-theme="dark"] :focus-visible/outline-color',
        tipo: "componente",
        fonte: {
          tipo: "grau",
          indice: 4,
          alfa: 1,
        },
        contra: null,
      },
    ],
    semanticas: [
      {
        nome: "success",
        hex: "#52d6a6",
      },
      {
        nome: "warning",
        hex: "#f7c46c",
      },
      {
        nome: "error",
        hex: "#ff8e95",
      },
      {
        nome: "info",
        hex: "#8fd9f5",
      },
    ],
    neutros: [
      "#f8fafb",
      "#f1f4f6",
      "#c4cdd4",
      "#92a0ab",
      "#647480",
      "#536573",
      "#3e4e5a",
      "#34424e",
      "#26333d",
      "#17232c",
      "#101820",
    ],
    indices: {
      accent: 7,
      hover: 8,
      soft: null,
    },
    alfaDoSoft: 0.16,
  },
};
