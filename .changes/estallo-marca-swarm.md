---
impacto: capacidade_nova
secao: adicionado
titulo: Estallo CRM ganha identidade própria e implantação Swarm isolada
---

O fork usa Estallo CRM como nome padrão, nome em texto e inicial E no ícone.
As imagens próprias são publicadas no registro da Estallo. A stack Swarm usa o
Traefik existente e inclui worker, scheduler e WhatsApp com limites de recursos.
O agente do host reporta as atualizações pela tela existente, preservando as
sessões e recuperando as três imagens juntas quando o rollout falha.

Destino: infraestrutura. A operação comum do CRM continua usando os mesmos
contratos, isolamento por organização e mecanismos de atendimento.
