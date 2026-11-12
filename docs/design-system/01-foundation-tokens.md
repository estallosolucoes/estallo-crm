# 01 — Fundamentos Estallo no CRM

Fonte de marca: [README](README.md). Implementação: `app/globals.css`. As escalas operacionais abaixo são a adaptação atual do CRM; o laboratório em `app/design/` não governa estes valores.

## Espaçamento e raio

Base de 4 px. Usar tokens `--space-*` e utilitários equivalentes: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96 e 128 px, conforme a hierarquia do conteúdo.

| Token de raio   | Valor atual |
| --------------- | ----------: |
| `--radius-none` |        0 px |
| `--radius-sm`   |        6 px |
| `--radius-md`   |       10 px |
| `--radius-lg`   |       14 px |
| `--radius-xl`   |       20 px |
| `--radius-full` |     9999 px |

O Brand System usa cantos arredondados e superfícies definidas. Controles, cards e overlays devem conservar essa família, sem importar os raios antigos do upstream.

## Superfícies, sombras e camadas

Consumir `--color-bg`, `--color-surface`, `--color-surface-elevated`, `--color-border` e `--shadow-*`. Usar separação legível e elevação coerente. Exemplos de sombra do Brand System orientam a direção; a aplicação consome os tokens versionados, com ajustes registrados ao redesenhar componentes.

Camadas atuais (`--z-*`): base 0, raised 10, dropdown 20, sticky 30, modal 40 e toast 50. Overlays respeitam foco, teclado e retorno ao elemento de origem.

Movimento: [07](07-motion-language.md). Densidade: [04](04-density-aerada.md). Não introduzir valores visuais soltos em cada feature.
