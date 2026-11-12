---
impacto: capacidade_nova
secao: adicionado
titulo: Agenda vira chave da empresa (desligada por padrão) e campos personalizados ganham cadastro central
---

**Agenda.** Em CRM (/app/crm), o administrador liga ou desliga a Agenda da empresa. Desligada, somem a tela, o item de menu, o atalho "Marcar compromisso" do inbox e as ferramentas de agendamento do agente de IA. Empresa nova nasce com a Agenda desligada; quem já tinha tipo de agendamento ou compromisso continua com ela ligada depois da atualização (migration 0656). A chave fica em `organizations.settings.agenda_habilitada` e é lida como capacidade (`agenda`).

**Campos personalizados.** CRM › Campos personalizados (/app/crm/campos, admin) é o cadastro da empresa para campos do negócio (Oportunidade) e do Contato: visibilidade global ou por funil/etapa, obrigatório em toda a empresa ou em etapas escolhidas (e ao ganhar/perder), opção de ocultar sem apagar valores, e ordem por arrastar. Os campos que existiam em cada funil migram sozinhos (migration 0657; a mesma chave em vários funis vira um campo só). O editor por funil em Configurações › Funis virou um link para esta tela, e "cadastrar campo" da captação grava no cadastro central. O dossiê mostra os campos do negócio da etapa atual e ganhou a aba "Campos" do contato; o follow-up ("Gravar a resposta em") passou a oferecer também campos do contato (`save_to.kind = "contact_custom"`). Por dentro, `crm_pipelines.settings.fields` continua existindo como projeção mantida pelo banco, então validação de obrigatórios, captação, regras e IA seguem lendo o mesmo formato.
