# Marca Estallo CRM

A identidade vigente é a Estallo, com descritor CRM, conforme o [Design System Estallo](../design-system/README.md). Símbolo, cores e fontes vêm do Estallo Brand System v1.0 fornecido pelo proprietário.

## Aplicação

- Geometria oficial: `lib/branding/desenho.ts`.
- Componente compartilhado: `components/branding/MarcaDoProduto.tsx`.
- Identidade fixa: `lib/branding/plataforma.ts`.
- Cores e fontes operacionais: `app/globals.css` e `app/layout.tsx`.

Usar a versão adequada ao fundo e preservar proporções e área de respiro. Não substituir a marca pela organização ativa. Os dados legais da empresa continuam independentes.

## Materiais herdados

Os arquivos `deskcomm-*`, o card `og-card.html` e sua imagem de social preview nesta pasta são materiais históricos do upstream. Não representam a Estallo, não devem ser usados em divulgação ou servir de referência visual. A adaptação do social preview está pendente. Sua existência preserva procedência; a identidade do aplicativo é resolvida pelo código indicado acima.

O histórico MIT e a atribuição DeskcommCRM são preservados. Isso não autoriza restaurar a identidade visual do upstream no produto.

## Evidências históricas do upstream

Estas capturas registram a implementação anterior à identidade Estallo e preservam o lastro histórico do repositório. Não representam o padrão visual atual nem devem orientar novos componentes.

| Arquivo                                           | Registro historico                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `evidence/marca/crm-login-claro.png`              | Fachada de entrada com o logotipo, tema claro                                             |
| `evidence/marca/crm-login-escuro.png`             | A mesma fachada no escuro: sálvia clara e nome em creme                                   |
| `evidence/marca/crm-sidebar-aberta.png`           | Barra lateral aberta com o logotipo                                                       |
| `evidence/marca/crm-sidebar-aberta-escura.png`    | Barra aberta no escuro                                                                    |
| `evidence/marca/crm-sidebar-recolhida.png`        | Barra recolhida (64px) só com o símbolo                                                   |
| `evidence/marca/crm-sidebar-recolhida-escura.png` | Barra recolhida no escuro                                                                 |
| `evidence/marca/favicon-produto.png`              | `/icon` gerado em runtime com o símbolo                                                   |
| `evidence/marca/crm-login-revendedor.png`         | Controle negativo: com `platform_branding.app_name` gravado, a fachada fica sem o desenho |
| `evidence/marca/favicon-revendedor.png`           | Controle negativo: o favicon volta à inicial sobre a cor de destaque                      |
| `evidence/marca/lp-cabecalho.png`                 | Cabeçalho da LP (`deskcomm-site`) com o logotipo                                          |
| `evidence/marca/lp-rodape.png`                    | Rodapé da LP com o símbolo                                                                |
