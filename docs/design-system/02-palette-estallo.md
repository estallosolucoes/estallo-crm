# 02 — Paleta Estallo

Origem: Estallo Brand System v1.0, conforme [README](README.md). As cores da marca não são substituídas por preferências da organização.

| Cor oficial   | Hex       | Papel                                |
| ------------- | --------- | ------------------------------------ |
| Estallo Blue  | `#1099D3` | Ação e destaque primário             |
| Estallo Green | `#10BA84` | Crescimento e resultado positivo     |
| Estallo Ink   | `#26333D` | Texto, títulos e navegação           |
| Deep Blue     | `#0B6E9A` | Variação escura do azul              |
| Deep Green    | `#0C8A62` | Variação escura do verde             |
| Slate         | `#3E4E5A` | Texto secundário e superfície escura |
| Sky           | `#E7F5FC` | Realce azul suave                    |
| Mint          | `#E5F8F1` | Realce verde suave                   |
| Cloud         | `#F1F4F6` | Superfície neutra                    |

Neutros complementares: `#34424E`, `#6B7A86`, `#92A0AB`, `#C4CDD4`, `#E2E7EB` e `#F8FAFB`. Feedback de marca: verde para sucesso, azul para informação, `#F5A623` para atenção e `#E5484D` para erro.

## Tokens operacionais e contraste

Componentes consomem tokens semânticos de `app/globals.css`, não hex literais. A assinatura visual utiliza as cores originais; texto, foco e controles podem usar variações mais escuras para atingir contraste. No tema claro atual, `--color-accent` usa `#0B6E9A` e `--color-success` usa `#087653`. Isso não redefine a cor do logotipo.

O tema escuro tem tokens próprios; não inverter cores automaticamente. Verificar ao menos 4,5:1 para texto normal e 3:1 para texto grande e elementos gráficos de interface relevantes. Nenhum número de contraste de documentos antigos constitui prova da paleta atual.

No tema escuro, superfícies azuis sólidas com texto ou ícone branco usam `accent-700` (`#095A7F`), conforme o modelo 02 aprovado pelo proprietário em 15/10/2026. O hover usa `accent-800` (`#084866`). Isso vale para balões enviados, botões primários, opções selecionadas, badges e itens de menu realçados. O branco tem contraste de 7,55:1 e 9,86:1 nesses fundos, respectivamente. Nome do remetente, horário e duração do áudio permanecem brancos, sem transparência. Os tokens claros `accent`/`primary` continuam disponíveis para links, foco e indicadores; não usá-los como fundo sólido com branco no tema escuro. O tema claro mantém suas cores atuais.

Combinar cor com rótulo, ícone ou forma para indicar estados. Verde comunica resultado e azul comunica ação.

## Gradientes e composição

O Brand System permite gradiente Blue → Green a 135°, orbs de luz e grafismos de fluxo em composição de marca. São opcionais para apresentação, acesso e marketing; preservar leitura e foco nas telas operacionais. A antiga proibição absoluta de gradientes não se aplica.

No tema escuro, fundos de ações azuis e balões enviados usam `#085A7F` (`accent-700`), com texto branco. O azul claro `#54BCE8` permanece na rampa para detalhes gráficos, sem servir de fundo para texto branco. Links e ícones azuis sobre superfícies escuras usam `--color-accent-text`, separado do fundo das ações.
