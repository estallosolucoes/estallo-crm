import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClient } from "@/lib/followup/engine";
import { PgExecutionJournal } from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type * as ContractModule from "@/lib/followup/execution-contract";

vi.mock("@/lib/followup/execution-contract", async (original) => {
  const m = await original<typeof ContractModule>();
  return {
    ...m,
    executionContractProblem: (...a: Parameters<typeof m.executionContractProblem>) => {
      const p = m.executionContractProblem(...a);
      return p === "execution_contract_unavailable" ? null : p;
    },
  };
});

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_AGENT_A, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * EDITAR TAG e TAREFA INTERNA: motor antigo × motor novo, no MESMO cenário.
 *
 * Mesmo método de `automacoes-mover-lead-antigo-x-novo.test.ts`: o antigo grava pelo adaptador REST
 * (`editarTagDoLead` → ação `add_tag`; `criarTarefaInterna` → `criarTarefaInterna` da casa), o novo
 * grava dentro do diário (`completeTags` / `completeTask`). Cada cenário cria dois negócios idênticos,
 * roda um em cada motor e compara o que ficou no banco. Sem `REST_URL`/`REST_SERVICE_KEY` o arquivo se
 * pula inteiro.
 */
const REST = Boolean(process.env.REST_URL && process.env.REST_SERVICE_KEY);
const suite = REST ? describe : describe.skip;

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 6,
});
const adapter = createPgAdminClient(pool);
const journal = new PgExecutionJournal(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

const rest = () =>
  createClient(process.env.REST_URL ?? "http://127.0.0.1:1", process.env.REST_SERVICE_KEY ?? "x", {
    auth: { persistSession: false },
  });

const nota = (...partes: unknown[]) =>
  process.stderr.write(`${partes.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);

type Cena = { contact: string; lead: string | null };

/** Um contato (e, se pedido, um negócio) por motor; mesmos dados nos dois. */
async function criar(opts: { semLead?: boolean; tags?: string[]; dono?: string | null; titulo?: string }) {
  const contact = randomUUID(),
    lead = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name,tags) values($1,$2,'Ana','Ana',$3)",
    [contact, GOV_ORG, []],
  );
  if (opts.semLead) return { contact, lead: null } satisfies Cena;
  const pipeline = randomUUID(),
    stage = randomUUID(),
    slug = randomUUID().slice(0, 8);
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Funil',$3)", [
    pipeline,
    GOV_ORG,
    `f-${slug}`,
  ]);
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Etapa',$4,1000)",
    [stage, GOV_ORG, pipeline, `e-${slug}`],
  );
  await pool.query(
    `insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage,tags,owner_user_id)
     values($1,$2,$3,$4,$5,$6,500,$7,$8)`,
    [
      lead,
      GOV_ORG,
      contact,
      pipeline,
      stage,
      opts.titulo ?? "Negócio",
      opts.tags ?? [],
      opts.dono === undefined ? GOV_AGENT_A : opts.dono,
    ],
  );
  return { contact, lead } satisfies Cena;
}

async function inscricaoNova(cena: Cena, node: { id: string; type: string; config: object }) {
  const run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, cena.contact);
  const graph = {
    execution_contract: 1,
    nodes: [
      { ...node, label: node.id, position: { x: 0, y: 0 } },
      { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "e", source: node.id, target: "fim", condition: { type: "always" } }],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [
    version,
    GOV_ORG,
    graph,
  ]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Cmp ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until,lead_id)
     values($1,$2,$3,$4,$5,$6,$7,1,$9,'active',now()-interval '1 second',now()+interval '2 minutes',$8)`,
    [run, GOV_ORG, flow, version, cena.contact, origin.conversation_id, origin, cena.lead, node.id],
  );
  return (await adapter.loadEnrollmentById(GOV_ORG, run))!;
}

const recusaDe = (e: unknown) => (e as { code?: string; message?: string }).code ?? (e as Error).message;

/* ───────────────────────────── TAG ───────────────────────────── */

type ObsTag = {
  recusa: string | null;
  tagsDoLead: string[] | null;
  tagsDoContato: string[];
  eventos: string[];
  atividades: string[];
  auditoria: string[];
};

async function observarTag(c: Cena, recusa: string | null): Promise<ObsTag> {
  const alvo = c.lead ?? c.contact;
  const lead = c.lead
    ? (await pool.query("select tags from crm_leads where organization_id=$1 and id=$2", [GOV_ORG, c.lead]))
        .rows[0]
    : null;
  const contato = (await pool.query("select tags from contacts where organization_id=$1 and id=$2", [GOV_ORG, c.contact]))
    .rows[0];
  return {
    recusa,
    tagsDoLead: lead ? (lead.tags as string[]) : null,
    tagsDoContato: contato.tags as string[],
    eventos: (
      await pool.query(
        "select event_type from event_log where organization_id=$1 and entity_id in ($2,$3) order by created_at",
        [GOV_ORG, alvo, c.contact],
      )
    ).rows.map((r) => r.event_type as string),
    atividades: c.lead
      ? (
          await pool.query(
            "select type from crm_lead_activities where organization_id=$1 and lead_id=$2 order by performed_at",
            [GOV_ORG, c.lead],
          )
        ).rows.map((r) => r.type as string)
      : [],
    auditoria: (
      await pool.query(
        "select action from api_audit_log where organization_id=$1 and resource_id=$2 order by created_at",
        [GOV_ORG, alvo],
      )
    ).rows.map((r) => r.action as string),
  };
}

type DestinoTag = { destino?: "card" | "contato" };

async function tagPelaAntiga(c: Cena, tags: string[], extra: DestinoTag = {}) {
  let recusa: string | null = null;
  try {
    await createSupabaseAdminClient(rest()).editarTagDoLead!({
      organization_id: GOV_ORG,
      contact_id: c.contact,
      enrollment_id: randomUUID(),
      config: { tags, ...extra },
    } as never);
  } catch (e) {
    recusa = recusaDe(e);
  }
  return observarTag(c, recusa);
}

async function tagPelaNova(c: Cena, tags: string[], extra: DestinoTag = {}) {
  let recusa: string | null = null;
  try {
    const scope = await inscricaoNova(c, { id: "tag", type: "edit_lead_tag", config: { tags, ...extra } });
    const begun = await journal.begin(scope, { contact_id: c.contact });
    if (begun.kind !== "ready") throw new Error(`begin_${begun.kind}`);
    await journal.completeTags(scope, begun.handle);
  } catch (e) {
    recusa = recusaDe(e);
  }
  return observarTag(c, recusa);
}

async function cenarioTag(inicio: Parameters<typeof criar>[0], tags: string[], extra: DestinoTag = {}) {
  const a = await criar(inicio),
    b = await criar(inicio);
  return { antigo: await tagPelaAntiga(a, tags, extra), novo: await tagPelaNova(b, tags, extra) };
}

suite("editar tag: motor antigo × motor novo (mesmo cenário, dois negócios idênticos)", () => {
  it("negócio sem tag + uma tag nova: mesmas tags e mesmo evento", async () => {
    const { antigo, novo } = await cenarioTag({}, ["vip"]);
    nota("[tag nova] antigo:", antigo, "| novo:", novo);
    expect(antigo.recusa).toBeNull();
    expect(novo.recusa).toBeNull();
    expect(novo.tagsDoLead).toEqual(antigo.tagsDoLead);
    expect(novo.tagsDoLead).toEqual(["vip"]);
    expect(novo.eventos).toEqual(antigo.eventos);
  });

  it("negócio com tags + mistura de repetida e nova: merge idempotente igual, sem apagar as existentes", async () => {
    const { antigo, novo } = await cenarioTag({ tags: ["a", "b"] }, ["b", "vip"]);
    expect(antigo.recusa).toBeNull();
    expect(novo.recusa).toBeNull();
    expect(novo.tagsDoLead).toEqual(antigo.tagsDoLead);
    expect(novo.tagsDoLead).toEqual(["a", "b", "vip"]);
    expect(novo.eventos).toEqual(antigo.eventos);
  });

  it("tag que o negócio já tem: nenhum dos dois muda nada nem emite evento", async () => {
    const { antigo, novo } = await cenarioTag({ tags: ["vip"] }, ["vip"]);
    expect(novo.recusa).toBe(antigo.recusa);
    expect(novo.tagsDoLead).toEqual(antigo.tagsDoLead);
    expect(novo.eventos).toEqual([]);
    expect(antigo.eventos).toEqual([]);
  });

  it("registros extras do novo (atividade e auditoria): medidos, não comparados", async () => {
    const { antigo, novo } = await cenarioTag({}, ["vip"]);
    nota("[atividade] antigo:", antigo.atividades, "novo:", novo.atividades);
    nota("[auditoria] antigo:", antigo.auditoria, "novo:", novo.auditoria);
    // O novo registra a edição na linha do tempo do negócio; o antigo (a ação `add_tag`) não.
    expect(novo.atividades).toContain("lead_edited");
    expect(antigo.atividades).not.toContain("lead_edited");
  });

  it("destino \"contato\" SEM negócio: os dois gravam a tag no contato (a divergência acima some com a opção)", async () => {
    const { antigo, novo } = await cenarioTag({ semLead: true }, ["vip"], { destino: "contato" });
    expect(antigo.recusa).toBeNull();
    expect(novo.recusa).toBeNull();
    expect(novo.tagsDoContato).toEqual(["vip"]);
    expect(novo.tagsDoContato).toEqual(antigo.tagsDoContato);
    expect(novo.eventos).toEqual(antigo.eventos);
    expect(novo.eventos).toEqual(["contact.tag_added"]);
  });

  it("destino \"contato\" COM negócio: grava no contato e não toca nas tags do negócio, nos dois", async () => {
    const { antigo, novo } = await cenarioTag({ tags: ["a"] }, ["vip"], { destino: "contato" });
    expect(novo.recusa).toBe(antigo.recusa);
    expect(novo.tagsDoContato).toEqual(["vip"]);
    expect(novo.tagsDoContato).toEqual(antigo.tagsDoContato);
    expect(novo.tagsDoLead).toEqual(["a"]);
    expect(antigo.tagsDoLead).toEqual(["a"]);
  });

  it("DIVERGÊNCIA CONHECIDA — contato SEM negócio e destino padrão (negócio): o antigo grava a tag no contato; o novo recusa", async () => {
    const { antigo, novo } = await cenarioTag({ semLead: true }, ["vip"]);
    nota("[sem negócio] antigo:", antigo, "| novo:", novo);
    expect(antigo.recusa).toBeNull();
    expect(antigo.tagsDoContato).toEqual(["vip"]);
    expect(novo.recusa).not.toBeNull();
    expect(novo.tagsDoContato).toEqual([]);
  });
});

/* ───────────────────────────── TAREFA ───────────────────────────── */

type ObsTarefa = {
  recusa: string | null;
  tarefas: {
    title: string;
    priority: string;
    status: string;
    assigned_to: string | null;
    com_lead: boolean;
    com_contato: boolean;
    prazo_em_dias: number;
  }[];
  atividades: string[];
  auditoria: string[];
};

type ConfigTarefa = {
  titulo: string;
  vence_em_dias: number;
  atribuir_a: "dono_do_lead" | { usuario_id: string };
  prioridade: "low" | "medium" | "high" | "urgent";
};

async function observarTarefa(c: Cena, recusa: string | null): Promise<ObsTarefa> {
  const tarefas = (
    await pool.query(
      `select title,priority,status,assigned_to,lead_id,contact_id,
              extract(epoch from (due_date - created_at))/86400 as dias
         from crm_tasks where organization_id=$1 and contact_id=$2`,
      [GOV_ORG, c.contact],
    )
  ).rows;
  return {
    recusa,
    tarefas: tarefas.map((t) => ({
      title: t.title,
      priority: t.priority,
      status: t.status,
      assigned_to: t.assigned_to,
      com_lead: Boolean(t.lead_id),
      com_contato: Boolean(t.contact_id),
      prazo_em_dias: Math.round(Number(t.dias)),
    })),
    atividades: c.lead
      ? (
          await pool.query(
            "select type from crm_lead_activities where organization_id=$1 and lead_id=$2 order by performed_at",
            [GOV_ORG, c.lead],
          )
        ).rows.map((r) => r.type as string)
      : [],
    auditoria: (
      await pool.query(
        `select a.action from api_audit_log a join crm_tasks t on t.id::text = a.resource_id::text
          where a.organization_id=$1 and t.contact_id=$2 order by a.created_at`,
        [GOV_ORG, c.contact],
      )
    ).rows.map((r) => r.action as string),
  };
}

async function tarefaPelaAntiga(c: Cena, config: ConfigTarefa) {
  let recusa: string | null = null;
  try {
    await createSupabaseAdminClient(rest()).criarTarefaInterna!({
      organization_id: GOV_ORG,
      contact_id: c.contact,
      enrollment_id: randomUUID(),
      config,
    } as never);
  } catch (e) {
    recusa = recusaDe(e);
  }
  return observarTarefa(c, recusa);
}

async function tarefaPelaNova(c: Cena, config: ConfigTarefa) {
  let recusa: string | null = null;
  try {
    const scope = await inscricaoNova(c, { id: "task", type: "internal_task", config });
    const begun = await journal.begin(scope, { contact_id: c.contact });
    if (begun.kind !== "ready") throw new Error(`begin_${begun.kind}`);
    await journal.completeTask(scope, begun.handle);
  } catch (e) {
    recusa = recusaDe(e);
  }
  return observarTarefa(c, recusa);
}

async function cenarioTarefa(inicio: Parameters<typeof criar>[0], config: ConfigTarefa) {
  const a = await criar(inicio),
    b = await criar(inicio);
  return { antigo: await tarefaPelaAntiga(a, config), novo: await tarefaPelaNova(b, config) };
}

const base: ConfigTarefa = {
  titulo: "Ligar para o cliente",
  vence_em_dias: 2,
  atribuir_a: "dono_do_lead",
  prioridade: "high",
};

suite("tarefa interna: motor antigo × motor novo (mesmo cenário, dois negócios idênticos)", () => {
  it("dono do negócio como responsável: mesma tarefa (título, prioridade, responsável, prazo, vínculos)", async () => {
    const { antigo, novo } = await cenarioTarefa({}, base);
    nota("[tarefa] antigo:", antigo, "| novo:", novo);
    expect(antigo.recusa).toBeNull();
    expect(novo.recusa).toBeNull();
    expect(antigo.tarefas).toHaveLength(1);
    expect(novo.tarefas).toEqual(antigo.tarefas);
    expect(novo.atividades).toEqual(antigo.atividades);
  });

  it("título com {{lead.title}} e {{contact.name}}: mesmo título resolvido", async () => {
    const { antigo, novo } = await cenarioTarefa(
      { titulo: "Reforma da Ana" },
      { ...base, titulo: "Retornar {{contact.name}} sobre {{lead.title}}" },
    );
    expect(novo.tarefas).toEqual(antigo.tarefas);
    expect(novo.tarefas[0]?.title).toBe("Retornar Ana sobre Reforma da Ana");
  });

  it("responsável escolhido na regra: mesma tarefa", async () => {
    const { antigo, novo } = await cenarioTarefa({}, { ...base, atribuir_a: { usuario_id: GOV_AGENT_A }, vence_em_dias: 0 });
    expect(novo.recusa).toBe(antigo.recusa);
    expect(novo.tarefas).toEqual(antigo.tarefas);
  });

  it("registros extras (atividade e auditoria): medidos", async () => {
    const { antigo, novo } = await cenarioTarefa({}, base);
    nota("[atividade] antigo:", antigo.atividades, "novo:", novo.atividades);
    nota("[auditoria] antigo:", antigo.auditoria, "novo:", novo.auditoria);
    expect(novo.atividades).toEqual(antigo.atividades);
  });

  it("negócio SEM dono + 'dono do negócio': nenhuma tarefa nos dois (o antigo segue calado, o novo recusa)", async () => {
    const { antigo, novo } = await cenarioTarefa({ dono: null }, base);
    nota("[sem dono] antigo:", antigo.recusa, antigo.tarefas.length, "| novo:", novo.recusa, novo.tarefas.length);
    expect(antigo.tarefas).toHaveLength(0);
    expect(novo.tarefas).toHaveLength(0);
    expect(antigo.recusa).toBeNull(); // antigo só registra no log e o fluxo avança
    expect(novo.recusa).not.toBeNull();
  });

  it("responsável que não é da organização: nenhuma tarefa nos dois", async () => {
    const { antigo, novo } = await cenarioTarefa({}, { ...base, atribuir_a: { usuario_id: randomUUID() } });
    nota("[responsável de fora] antigo:", antigo.recusa, antigo.tarefas.length, "| novo:", novo.recusa, novo.tarefas.length);
    expect(antigo.tarefas).toHaveLength(0);
    expect(novo.tarefas).toHaveLength(0);
  });

  it("contato SEM negócio + responsável escolhido: medido", async () => {
    const { antigo, novo } = await cenarioTarefa(
      { semLead: true },
      { ...base, atribuir_a: { usuario_id: GOV_AGENT_A } },
    );
    nota("[sem negócio] antigo:", antigo, "| novo:", novo);
    expect(novo.tarefas).toEqual(antigo.tarefas);
  });
});
