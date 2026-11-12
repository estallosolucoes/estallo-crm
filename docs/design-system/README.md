# Design System Estallo — padrão do Estallo CRM

**Status: vigente. Revisão: 14/10/2026.** O Design System da Estallo é a única referência visual do produto. Vale para todas as telas novas e próximos redesenhos; não existe um padrão diferente para módulos internos.

## Origem e precedência

A referência fornecida pelo proprietário é o **Estallo Brand System v1.0**, no arquivo `C:\Projetos Claude\estallo\Design System\Estallo Brand System.dc.html`, com os assets da mesma pasta. Seus fundamentos estão registrados neste conjunto de documentos para que o desenvolvimento não dependa dessa pasta local.

Este conjunto aplica o Brand System ao CRM, sob a doutrina de `CLAUDE.md`. Specs, planos, handoffs e exemplos antigos não podem restaurar escolhas visuais herdadas. Seus contratos técnicos, permissões e jornadas continuam válidos dentro de seu escopo.

## Padrão obrigatório

- Marca fixa Estallo CRM com símbolo e logotipo oficiais. A empresa ativa é contexto da conta, sem substituir a identidade da plataforma.
- Sora para títulos, Manrope para leitura e controles, JetBrains Mono para dados técnicos.
- Estallo Blue para ação, Estallo Green para resultado e Ink para texto e navegação. Temas claro e escuro com contraste verificado.
- No tema escuro, o fundo de ações azuis é `#085A7F`; azul claro não recebe texto branco. Texto sobre o Estallo Blue (botão primário, chip de ação, item ativo) é **sempre branco**, nos dois temas (`--color-accent-fg: #ffffff` em `app/globals.css`). Decisão do dono em 2026-10-14: texto escuro sobre azul tinha razão de contraste maior, mas leitura pior aos olhos — a escolha é deliberada, não descuido.
- A regra vale para **qualquer fundo azul**, não só o token (decisão do dono em 2026-10-15): cor de etiqueta, cor de etapa do funil, `hover`/`focus`/selecionado em `bg-accent`/`bg-primary`. Fundo sólido azul sempre leva `text-accent-foreground` (ou `text-white`) junto; cor dinâmica passa por `frenteSobreCor()` em `lib/branding/contraste.ts`, que devolve branco para azul e a régua de contraste para as demais cores. A exceção são os tons **pastel** (accent-50…200, `bg-accent-soft`): neles o texto segue escuro. Não usar `hover:bg-accent` como realce neutro (idioma do shadcn): para realce neutro, `bg-surface-elevated`.
- Layout claro, hierarquia consistente, respiro e densidade adequada ao atendimento.
- Gradiente azul → verde e grafismos de marca são permitidos em composição, sem prejudicar leitura ou operação.
- Componentes compartilhados, tokens semânticos e acessibilidade; nenhuma tela cria uma identidade própria.

## Documentos

| Documento                                      | Uso                                 |
| ---------------------------------------------- | ----------------------------------- |
| [00 — Overview](00-overview.md)                | Princípios e escopo                 |
| [01 — Fundamentos](01-foundation-tokens.md)    | Espaçamento, raio, sombra e camadas |
| [02 — Paleta Estallo](02-palette-estallo.md)   | Cores oficiais, papéis e contraste  |
| [03 — Tipografia](03-typography.md)            | Fontes e hierarquia                 |
| [04 — Densidade](04-density-aerada.md)         | Leitura e responsividade            |
| [05 — Iconografia](05-iconography-phosphor.md) | Convenção de ícones do CRM          |
| [06 — Componentes](06-components.md)           | Estados e composição                |
| [07 — Movimento](07-motion-language.md)        | Transições e redução de movimento   |
| [08 — Voz e tom](08-voice-and-tone.md)         | Linguagem e microcopy               |
| [09 — Anti-patterns](09-anti-patterns.md)      | Escolhas que violam o padrão        |
| [Fluxos de tela](screen-flow/README.md)        | Jornadas, estados e acessibilidade  |

## Implementação e escopo atual

Tokens do produto: `app/globals.css`. Espelho runtime verificado por teste: `lib/branding/regua-do-produto.ts`. Fontes locais: `app/layout.tsx` e `app/fonts/`. Identidade fixa: `lib/branding/plataforma.ts`. Geometria oficial: `lib/branding/desenho.ts`. Navegação: `lib/navigation/registry.ts`.

A primeira etapa aplicou identidade, acesso, navegação e apresentação dos planos. O redesenho completo de Inbox, kanban, dashboard e demais módulos é progressivo, sempre sob este mesmo padrão. Isso não significa que todas as telas já passaram por revisão visual.

O laboratório em `app/design/` contém experimentos herdados e não é fonte normativa. Não copiar seus seletores de paleta, fontes alternativas ou valores visuais para o produto. A adaptação dessa vitrine é pendente.

Mudanças de identidade devem atualizar a documentação e os tokens correspondentes, com prova visual nos dois temas e em mobile. Histórico e atribuição upstream são preservados no Git.
