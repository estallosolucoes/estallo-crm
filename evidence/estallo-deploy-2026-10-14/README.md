# Deploy direto Estallo CRM — 14/10/2026

Nova identidade publicada em https://crm.estallo.com.br, sem GitHub Actions e sem build pesado na VPS compartilhada.

As três imagens Linux/AMD64 foram construídas pelos Dockerfiles do snapshot Git `8563e3b720c8c34a07f4360f51f1023897885312`. A receita operacional do clone na VPS é `3184834d5`, que acrescenta proteção de dependências e QA, sem mudanças no código da aplicação ou worker. Build Linux completo passou, incluindo TypeScript. Os 25 testes Python do procedimento operacional passaram.

Os arquivos foram transferidos por SSH e seus hashes SHA-256 conferidos antes de `docker load`:

- Aplicação: `3ac1e57ba4babf6f567dad102790445bfaab6bbc006f92dbb35bbd11be0a5362`.
- Worker e scheduler: `3433800b5f609c261ded388aa71ec3b19ef095c3bed575a02049809d85cb3f17`.

O deploy criou o backup `20261014T121725226010Z`, verificou saúde/HTTPS e manteve margem de memória por um minuto após convergência. A cópia externa do backup e dos arquivos de imagens fica no destino do piloto em `C:\Users\junio\OneDrive\Documentos\backup-estallo-crm`. Essa é uma cópia no computador; sincronização efetiva pelo OneDrive e restauração em outro servidor não foram ensaiadas nesta atualização.

O backup pós-publicação `20261014T122900892310Z` também foi criado e copiado, com recibo `.copied.json`. Ele registra o estado instalado novo. Os arquivos de imagens, seus hashes, snapshot do código e bundle da receita operacional foram guardados na subpasta `images/8563e3b720c8c34a07f4360f51f1023897885312` desse destino. Os 67 testes de referências de evidência passaram após versionar as capturas abaixo.

## Prova pela interface publicada

- [Login desktop](login-desktop.png), [escuro](login-escuro.png), [mobile](login-mobile.png) e [mobile escuro](login-mobile-escuro.png).
- [Planos e navegação desktop](planos-desktop.png), [escuro](planos-escuro.png) e [mobile](planos-mobile.png).
- [Menu recolhido](navegacao-recolhida.png) e [gaveta mobile](navegacao-mobile.png).

[resultado.json](resultado.json) registra a revisão publicada, dependências saudáveis, login real do administrador, ícone PNG HTTP 200, temas, navegação e zero erros de navegador. As capturas verificam ausência de overflow horizontal. Os três botões de contratação foram conferidos como desativados. O script `scripts/qa-estallo-identidade.mjs` aceita produção somente com modo explícito, domínio exato autorizado, revisão esperada e credenciais em arquivo protegido. Não imprime erros de preenchimento que possam revelar a senha.

## Operação preservada

[operacao.json](operacao.json) registra a comparação de 20 domínios públicos, sem regressão de resposta HTTP, e os containers dos demais projetos sem recriação. WhatsApp voltou a `WORKING` com a sessão existente. Não foram enviadas mensagens de teste, acionados pagamentos ou alterados cadastros por esta verificação; a sessão autenticada mantém o sinal de presença já existente.

O WAHA foi recriado pelo Swarm durante a normalização da especificação: defaults, ordem dos mounts e metadados de plataforma mudaram. Seu digest e os volumes `estallo-crm_waha-data`/`estallo-crm_waha-media` permaneceram os mesmos. Redis e adaptador HTTP não foram recriados. O rollback automático permanece disponível; não foi feito um ensaio de retorno à versão anterior nesta publicação.

Planos continuam demonstrativos. Stripe e preços definitivos permanecem pendentes. Não houve alteração de schema, reaplicação de baseline ou execução das suítes completas de banco/E2E contra ambiente fresco nesta atualização.
