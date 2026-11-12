# Chat suspenso

Conversar com o contato sem sair da tela atual. O ícone do WhatsApp no card do
funil e o botão **Conversar** numa tarefa com oportunidade abrem a conversa numa
janela compacta no canto inferior direito, com o **mesmo** fio e o **mesmo**
composer do Inbox: texto, áudio, anexos, emoji e respostas rápidas (`/`).

- Vários contatos podem ficar abertos (até 6). Só um fica expandido; os outros
  aparecem como avatares empilhados à esquerda da janela, com o número de não
  lidas. Clicar num avatar alterna; passar o mouse mostra o nome e o **x** de
  fechar.
- **Minimizar** recolhe tudo numa bolha com o total de não lidas das conversas
  abertas. Clicar na bolha restaura.
- **Fechar** tira a conversa do canto. Não encerra nem altera o atendimento.
- O cabeçalho leva ao cadastro do contato (`/app/contacts/[id]`) e ao Inbox
  completo (`/app/inbox?id=`).
- Alternar, minimizar e navegar entre módulos preservam o texto não enviado e a
  posição de leitura: as conversas abertas ficam montadas, só uma visível. A
  lista de abertas vai para o `sessionStorage` da aba e volta depois de um F5.
- No próprio Inbox o chat suspenso some (a tela já é o chat) e volta ao sair.

## Limites e recuperação

- As APIs, a RLS, o envio, os anexos e o histórico são os do Inbox. Não há
  endpoint novo de mensagens.
- Suporte somente leitura, contato bloqueado/anonimizado, conversa encerrada e
  janela de 24h fechada impedem o envio pela mesma regra do Inbox
  (`hooks/inbox/useEstadoDoEnvio.ts`).
- Conversa minimizada ou atrás de outra não é marcada como lida. A visível é
  publicada no `OpenConversationProvider`, então não gera aviso duplicado.
- Tarefa cujo contato não tem conversa abre o fluxo de conversa nova (com
  escolha de canal quando há mais de um), e o resultado vai para o chat suspenso.
- Com chamada de voz ativa, o chat sobe para não cobrir os controles da chamada.

## Living System Checklist

1. Entrada: `useChatSuspenso().abrir(id)` — `KanbanCard` e `ListaDeTarefas`.
2. Saída: `ChatThread` e `Composer` do Inbox; link para o Inbox completo.
3. Registro: envio passa por `useSendMessage` e pelas APIs existentes (auditoria
   inclusa).
4. Visibilidade: o mesmo histórico no chat suspenso e no Inbox (mesmas chaves do
   react-query: `["messages", id]`, `["conversation", id]`).
5. Porta: `AppShell` monta `ProvedorDoChatSuspenso` e `ChatSuspenso`.
6. Anti-morte: canal `conversations` da org enquanto há chat aberto, mais o
   canal de mensagens de cada fio e `alinharFioComAPrevia` (o fio é relido
   quando a conversa anuncia mensagem mais nova que a última do fio).
7. Configuração: nenhuma; permissões e canais existentes.
8. Continuidade: o mesmo atendimento IA/humano; os controles completos ficam no
   Inbox, a um clique.
9. Retorno: erro de envio aparece no Composer; conversa inacessível mostra
   **Tentar novamente**.
10. Mapa: `docs/architecture/chat-suspenso.architecture.json`.
