---
impacto: nada_mudou
secao: corrigido
titulo: Quem já está logado e abre a página inicial volta a cair no painel
---
Atrás do proxy, o redirecionamento da página inicial para o painel apontava para o endereço interno do servidor, e o navegador mostrava "Não é possível acessar esse site". Agora o redirecionamento é relativo ao domínio em uso.
