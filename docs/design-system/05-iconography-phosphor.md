# 05 — Iconografia do Estallo CRM

A marca usa o símbolo oficial Estallo. Ícones de interface comunicam ações e estados; não substituem o logo.

O CRM mantém Phosphor via `lib/ui/icons.ts` como convenção técnica compartilhada. É uma adaptação do aplicativo ao Design System Estallo, não uma exigência atribuída ao Brand System.

- Importar pelo módulo canônico; evitar misturar bibliotecas na mesma tela.
- Manter tamanho, peso e alinhamento consistentes entre ações do mesmo nível. Regular ou duotone conforme o componente compartilhado.
- Aplicar cor por tokens semânticos.
- Ícone decorativo recebe `aria-hidden`; botão apenas com ícone precisa de nome acessível.
- Não depender só de ícone ou cor para comunicar falha, responsável ou próximo passo.

O catálogo de navegação permanece em `lib/navigation/registry.ts`. Mudanças de ícone não alteram permissões nem o significado da ação.
