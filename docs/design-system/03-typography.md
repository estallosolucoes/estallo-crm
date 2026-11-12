# 03 — Tipografia Estallo

Fonte: Estallo Brand System v1.0, conforme [README](README.md).

| Família        | Papel                              | Variável do aplicativo |
| -------------- | ---------------------------------- | ---------------------- |
| Sora           | Títulos e hierarquia de marca      | `--font-sora`          |
| Manrope        | Corpo, leitura, labels e controles | `--font-manrope`       |
| JetBrains Mono | IDs, código e dados técnicos       | `--font-jetbrains`     |

Fontes locais declaradas em `app/layout.tsx`, com arquivos e licenças em `app/fonts/`. Consumir aliases semânticos de tipografia em `app/globals.css`; não carregar uma fonte externa por componente.

Usar Sora para títulos e Manrope para atendimento; mono onde favorece precisão. Números de tabela podem usar `tabular-nums`, sem obrigar todos os dados a serem monoespaçados.

A escala de apresentação do Brand System orienta capas e chamadas. No CRM, ajustar tamanho ao contexto e à largura: listas e configurações não usam automaticamente títulos de marketing. Não reduzir texto de controle para fazer o layout caber.

Pares experimentais de `app/design/lib/fonts.ts` não são alternativas oficiais. O SaaS não oferece seletor de família por empresa.

Escala de operação (16/10/2026): corpo e controles `text-sm` em 15px, informação secundária `text-xs` em 13px, metadados legados com piso de 12px. Não usar texto de 8–11px para navegação ou informação de atendimento. Ícones dos botões compartilhados em 18px. Ajustar quebra e truncamento em vez de comprimir o texto.
