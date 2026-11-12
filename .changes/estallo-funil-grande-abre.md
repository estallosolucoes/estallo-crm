---
impacto: nada_mudou
secao: corrigido
titulo: Funis com muitos negócios abrem sem estourar o tempo e sem deixar o sistema lento
---

Funis grandes (mais de mil negócios, contando ganhos e perdidos) davam "Não consegui carregar este funil: A requisição não respondeu em 10000ms" e deixavam o resto do sistema lento, Inbox inclusive. O quadro agora busca os dados complementares de cada negócio ao mesmo tempo, e não um depois do outro.

Mudanças que chegam em sequência, como mensagens e atualizações da IA, viram uma única releitura do quadro. Antes, cada mudança abandonava a leitura em andamento e começava outra, e as leituras abandonadas se acumulavam no servidor.

Funis com mais de mil negócios mostravam só os mil primeiros. Agora aparecem todos.

Os funis fixados no menu passaram a ser de cada organização. Quem já tinha fixado precisa fixar de novo, uma vez em cada organização.

Toda consulta do servidor ao banco ganhou prazo (20 s; 60 s para arquivos). Antes, uma consulta pendurada esperava para sempre, e o sistema inteiro ficava em carregamento infinito até alguém reiniciar o app. Agora a ação mostra o erro e a próxima tentativa funciona. Se o app ainda assim perder o contato com o banco, ele se reinicia sozinho em cerca de 2 minutos.

A conferência de quem pode ver cada negócio passou a ser calculada uma vez por consulta, e não para cada negócio. Quem vê o quê continua igual. Num funil com mais de mil negócios, a leitura caía de cerca de 4 segundos no banco, e eram esses picos que deixavam o sistema inteiro lento e davam "Erro inesperado" ao ganhar um negócio ou enviar uma mensagem.
