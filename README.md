# Estallo CRM

CRM SaaS da Estallo para empresas que atendem e vendem por WhatsApp. Atendimento, clientes, funil, agenda e automação com IA em uma plataforma administrada pela Estallo.

[Visão do produto](VISION.md) · [Direção e pendências](docs/estallo-produto.md) · [Documentação técnica](docs/index.md) · [Operação da VPS](docs/estallo-vps.md)

## Modelo do produto

- SaaS hospedado pela Estallo, com contas por organização e isolamento multi-tenant.
- Marca Estallo CRM fixa. Nome e dados da empresa identificam a conta e os documentos comerciais.
- Planos e limites fazem parte da oferta futura. A apresentação atual é demonstrativa: não cobra nem aplica limites.
- Stripe será a integração comercial, usando a implementação do Nutrigg como referência. Credenciais, produtos e preços finais estão pendentes.

## Identidade

Logo oficial, Sora nos títulos, Manrope na interface e JetBrains Mono nos dados técnicos. Azul para ação, verde para resultado e Ink para navegação. Fontes e geometria são versionadas para não depender de serviços externos durante o build ou uso.

## Desenvolvimento

Node 22 e pnpm 9.15.9. Segredos ficam fora do Git; `.env.example` documenta o contrato de configuração.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build
```

Os gates complementares de banco, shell e E2E estão descritos em [AGENTS.md](AGENTS.md). Não execute E2E destrutivo contra produção. O deploy sai pelo GitHub Actions: o merge na `main` publica as imagens no GHCR (`publish-image.yml`) e o `deploy-vps.yml` manda a VPS trocá-las; migrations não vão junto (ver [docs/estallo-vps.md](docs/estallo-vps.md)).

## Operação atual

O piloto usa Supabase e Docker Swarm na VPS da Estallo. Deploy, backups, recuperação e limitações são descritos em [docs/estallo-vps.md](docs/estallo-vps.md). A primeira etapa do redesign está em [docs/estallo-produto.md](docs/estallo-produto.md). O [Design System Estallo](docs/design-system/README.md) é a única referência visual vigente para todos os módulos.

## Guias do assistente (Claude Code, Codex, Cursor, OpenCode, Antigravity)

O repositório traz guias que carregam sozinhos no assistente: operar o CRM, montar um cliente por nicho,
analisar métricas, afinar o prompt de um agente e contribuir. Para tê-los em qualquer pasta, rode uma vez:

```bash
curl -fsSL https://raw.githubusercontent.com/wjuniorl/estallo-crm/main/scripts/instalar-guias.sh | bash
```

Depois abra uma sessão nova e peça o assunto em português. Para chamar um guia pelo nome, cada assistente
tem o seu jeito: `/deskcomm-instalar` no Claude Code, no Cursor e no Antigravity; `$deskcomm-instalar` no
Codex; no OpenCode, peça pelo nome em linguagem natural.

Os guias **não** se atualizam sozinhos: rodar o mesmo comando de novo traz a versão nova. Para desfazer:

```bash
curl -fsSL https://raw.githubusercontent.com/wjuniorl/estallo-crm/main/scripts/instalar-guias.sh | bash -s -- --remover
```

Com o repositório clonado, os guias vêm dentro dele (`.agents/skills/`) e nem isso é preciso. Se você rodou o
comando mesmo assim, no Claude Code o guia instalado vale mais que o do clone, e fica na versão do dia em que
rodou, até rodar de novo (ou desfazer).

## Origem e licença

Fork de [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM). Código e histórico de origem, copyright e [licença MIT](LICENSE) preservados. O modelo comercial e a identidade do Estallo CRM são definidos pela Estallo; posicionamento histórico do upstream não descreve esta oferta.
