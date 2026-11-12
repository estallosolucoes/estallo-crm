---
impacto: nada_mudou
secao: alterado
titulo: Blocos de automação ganham a saída "Fallback erro" no motor novo de execução
---
Quando um bloco falha de vez (sem nova tentativa possível), o fluxo pode continuar por uma saída "Fallback erro" em vez de parar e abrir um aviso na Central. Resultado incerto (a mensagem pode ter saído) continua parando e avisando. A saída só aparece no construtor e só vale no motor novo, que ainda não está disponível nesta instalação; fluxos atuais não mudam.
