/**
 * ANEXOS DO BLOCO DE MENSAGENS DO FLUXO — a mídia que o operador sobe no construtor e o envio manda.
 *
 * O arquivo sobe UMA vez para `whatsapp-media/{org}/flow-assets/{uuid}/{arquivo}` (rota de upload do
 * construtor). No envio ele é COPIADO para a pasta da conversa, que é onde o handler de mensagens
 * aceita mídia (`isMediaPathOwnedBy`): a conversa passa a possuir a cópia — a inbox a mostra, a LGPD a
 * apaga junto com a conversa — e o arquivo do fluxo não se perde. Mesmo desenho da foto do catálogo
 * (`fotos-do-produto.ts`).
 *
 * O destino é determinístico: o replay de um job que caiu depois da cópia reaproveita o arquivo em vez de
 * encher a cota de Storage do cliente com duplicatas.
 *
 * Este módulo é do agent-engine e NÃO importa `lib/followup/*` (dependência numa direção só): o formato do
 * item é redeclarado aqui, e `tests/unit` cobra que os dois esquemas aceitem o mesmo que o motor enfileira.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';

export const BUCKET_DE_ANEXOS = 'whatsapp-media';
/** Segmento sob `{org}/` onde moram os anexos dos fluxos — nunca é um id de conversa (uuid). */
export const PASTA_DE_ANEXOS_DO_FLUXO = 'flow-assets';

const TIPOS_DE_MIDIA = ['image', 'video', 'audio', 'document'] as const;

export const itemDoFluxoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), body: z.string().min(1).max(4000) }),
  z.object({
    kind: z.enum(TIPOS_DE_MIDIA),
    path: z.string().min(1).max(400),
    mime: z.string().min(1).max(120),
    filename: z.string().min(1).max(200),
    size_bytes: z.number().int().positive(),
    caption: z.string().max(1024).optional(),
  }),
]);
export type ItemDoFluxo = z.infer<typeof itemDoFluxoSchema>;
export type ItemDeMidia = Extract<ItemDoFluxo, { kind: (typeof TIPOS_DE_MIDIA)[number] }>;

/**
 * O caminho é DESTA organização e está na pasta de anexos de fluxo? A graph é jsonb gravável por quem
 * monta o fluxo, e a cópia é por service role — sem este corte, um caminho de outra organização (ou de
 * outra conversa) sairia pelo WhatsApp deste contato.
 */
export function anexoPertenceAoFluxoDaOrg(path: string, orgId: string): boolean {
  const prefixo = `${orgId}/${PASTA_DE_ANEXOS_DO_FLUXO}/`;
  if (!path.startsWith(prefixo)) return false;
  const resto = path.slice(prefixo.length);
  if (resto.includes('\\')) return false;
  return resto.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Para onde o anexo vai na pasta da conversa. Determinístico (ver o cabeçalho). */
export function destinoDoAnexoNaConversa(orgId: string, conversationId: string, path: string): string {
  const selo = createHash('sha1').update(path).digest('hex').slice(0, 12);
  const arquivo = path.split('/').pop() ?? 'anexo';
  return `${orgId}/${conversationId}/fluxo-${selo}-${arquivo}`;
}

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export type AnexoNaConversa = { ok: true; storagePath: string } | { ok: false; motivo: string };

/** Copia o anexo para a pasta da conversa. `ok:false` é recusa PERMANENTE (caminho alheio ou arquivo sumido). */
export async function copiarAnexoParaConversa(
  log: Log,
  input: { orgId: string; conversationId: string; path: string },
): Promise<AnexoNaConversa> {
  if (!anexoPertenceAoFluxoDaOrg(input.path, input.orgId)) {
    return { ok: false, motivo: 'O anexo não é desta organização.' };
  }
  const destino = destinoDoAnexoNaConversa(input.orgId, input.conversationId, input.path);
  const { error } = await createAdminClient().storage.from(BUCKET_DE_ANEXOS).copy(input.path, destino);
  if (!error) return { ok: true, storagePath: destino };
  // Já copiado antes para esta conversa (replay): o arquivo que precisamos está lá.
  if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === '409') {
    return { ok: true, storagePath: destino };
  }
  // Arquivo do fluxo apagado do Storage: tempo não conserta, então o passo é pulado com o motivo.
  if (/not found|does not exist/i.test(error.message) || (error as { statusCode?: string }).statusCode === '404') {
    return { ok: false, motivo: 'O arquivo anexado ao fluxo não existe mais no armazenamento.' };
  }
  log.warn('anexo do fluxo não copiado para a conversa', { detalhe: error.message.slice(0, 120) });
  // Falha de infraestrutura: relança para a fila tentar de novo, em vez de pular o anexo em silêncio.
  throw new Error(`anexo do fluxo: cópia para a conversa falhou (${error.message.slice(0, 80)})`);
}
