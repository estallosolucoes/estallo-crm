# Identidade e navegação Estallo — 13/10/2026

Prova local com navegador Chromium real, aplicativo Next.js e conta de administrador do piloto. Não é uma suíte contra banco fresco: não foram criadas organizações, executadas migrations ou enviados pagamentos/mensagens nesta etapa. A sessão autenticada emite o sinal de presença já existente.

## Interface conferida

- [Acesso desktop](login-desktop.png) e [mobile](login-mobile.png).
- [Acesso escuro](login-escuro.png) e [mobile escuro](login-mobile-escuro.png).
- [Planos e menu desktop](planos-desktop.png), [escuro](planos-escuro.png) e [mobile](planos-mobile.png).
- [Navegação recolhida](navegacao-recolhida.png) e [gaveta mobile](navegacao-mobile.png).

O script `scripts/qa-estallo-identidade.mjs` só aceita localhost/127.0.0.1, lê credenciais de arquivo protegido quando solicitado e não as imprime. As capturas ocultam os indicadores de depuração do Next/React Query, presentes apenas no desenvolvimento.

Resultado em [resultado.json](resultado.json): título `Entrar · Estallo CRM`, ícone PNG HTTP 200, acesso autenticado a Plano e cobrança, menu Ink `rgb(38, 51, 61)`, gaveta mobile funcionando e zero erros de navegador. Todas as capturas verificam ausência de overflow horizontal. O menu foi recolhido e expandido pelos controles reais.

## Verificação de código

- Primeiro grupo: 33 testes passaram, cobrindo identidade fixa, saídas, catálogo e régua.
- Navegação, componente da marca, manifest, catálogo de portas e mapa foram conferidos. As expectativas de cor e ícone herdadas foram adaptadas para a identidade fixa.
- Grupo final de contraste, ícone público, régua e planos: 35 testes passaram. Os testes mantêm os pisos de contraste e a guarda de que o foco realmente foi medido.
- Gates de canal e papel passaram; guia de doutrina e espelho sincronizados. O lint completo encontrou um `prefer-const` no teste alterado, corrigido e revalidado.
- Typecheck completo passou com heap de 6 GB. A execução inicial com o heap padrão excedeu a memória do Node.
- Build de produção completo passou em 14/10/2026 (Node 22, Next.js/Turbopack, heap de 6 GB), incluindo a análise de TypeScript e geração das páginas. O ambiente de build não recebeu credenciais operacionais: avisos de IA/suporte não configurados e leituras de módulos em fallback são esperados nessa execução. A prova de interface autenticada foi feita separadamente, como descrito acima.
- Gates finais de documentação, versões declaradas, referências de evidência e guias embutidos: 162 testes passaram em quatro arquivos.
- A suíte unitária inteira e as suítes de banco/E2E com Supabase local fresco não foram executadas. Os grupos relevantes e a prova visual local acima não substituem esses gates completos.

## Estado comercial e implantação

Preços fictícios: Essencial R$ 97, Profissional R$ 197 e Escala R$ 397/mês. A tela informa que não cobra nem aplica os limites demonstrativos. Os três botões de contratação estão desativados; não há checkout ativo ou chamada Stripe.

Stripe será adaptado da referência Nutrigg. Credenciais, IDs de preços, catálogo definitivo e integração financeira permanecem pendentes. A licença MIT não foi alterada.

Nenhum workflow GitHub Actions foi iniciado. A nova identidade ainda não foi publicada na VPS. O piloto e as sessões WhatsApp não foram reiniciados por esta etapa.
