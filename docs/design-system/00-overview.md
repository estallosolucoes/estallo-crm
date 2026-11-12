# 00 — Visão do Design System Estallo

Fonte: [padrão vigente e origem](README.md). A Estallo transmite profissionalismo, inovação, confiança e clareza. Automação deve devolver tempo às pessoas; o CRM facilita atendimento e decisão, com benefícios compreensíveis e resultados verificáveis.

## Princípios

1. Clareza: ação principal, contexto e próximo passo reconhecíveis.
2. Identidade constante: símbolo oficial, Blue / Green / Ink e Sora / Manrope / JetBrains Mono.
3. Informação com propósito: estados, responsáveis e falhas visíveis, sem depender só de cor.
4. Conforto operacional: hierarquia, respiro e densidade adequada para uso prolongado.
5. Acessibilidade: contraste, foco, teclado, redução de movimento e responsividade.
6. Consistência: componentes e tokens compartilhados em vez de uma marca por módulo.

## Marca e navegação

Usar a geometria oficial registrada em `lib/branding/desenho.ts`. Não redesenhar o símbolo nem alterar proporções. A identidade pertence à Estallo; a empresa ativa é contexto da conta.

Organizar a navegação por objetivos — Atendimento, CRM, Agente de IA, Canais e Análise — conforme `lib/navigation/registry.ts`, respeitando RBAC, busca e navegação mobile. Configurações permanece acessível no rodapé.

## Aplicação ao CRM

O Brand System fornece a identidade. Densidade de listas, estados de conversa, movimento de overlays e componentes operacionais são adaptações do CRM dentro dela. Tamanhos de títulos de marketing não devem ser reproduzidos automaticamente numa tela de atendimento.

O padrão vale para todos os módulos, ainda que o redesenho aconteça em etapas. Uma tela antiga ou um experimento em `/design` não autoriza uma segunda linguagem visual.
