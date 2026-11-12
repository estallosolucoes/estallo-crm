/**
 * O `global.fetch` dos clients de SERVIDOR (#1082 / PR #1786).
 *
 * ─── Por que ele existe ──────────────────────────────────────────────────────
 *
 * A URL-base que se passa a `createClient`/`createServerClient` é a ORIGEM de
 * tudo que o SDK monta a partir dela. `signInWithOAuth` devolve
 * `${url}/auth/v1/authorize?…` e o storage devolve
 * `${urlStorage}/object/sign/…` — sem nenhuma chamada de rede no primeiro caso.
 * Se a base for a `SUPABASE_SERVER_URL`, esses links saem no endereço interno
 * (`http://kong:8000`) e chegam justamente a quem não o alcança: mídia, avatar,
 * fotos de produto, PDF da LGPD e login com Google apontados para o Kong.
 *
 * A correção é manter a base na URL PÚBLICA e desviar só o TRANSPORTE: este
 * fetch recebe as requisições do SDK já montadas na origem pública e reescreve
 * o prefixo para o endereço interno. O link continua saindo público, e o
 * caminho deixa de sair da rede.
 *
 * O inverso não fecha: com a base interna não há como adivinhar qual resposta
 * vira link e qual é só tráfego.
 *
 * ─── O que ele NÃO faz ──────────────────────────────────────────────────────
 *
 * Não decide nada. Quem passa os dois valores é o client que o chama, e a
 * política de qual endereço vale (trim, recusa do que não é http(s), aviso) é
 * de `urlDoSupabaseNoServidor`, uma vez só. Aqui só há uma comparação de
 * prefixo — e prefixo que não bate passa adiante, intacto: requisição para
 * outro host não é nossa.
 *
 * `lib/supabase/browser.ts` não usa isto. O navegador continua inteiro na URL
 * pública.
 */

import { logger } from "@/lib/logger";

/**
 * PRAZO EM TODA CHAMADA DO SERVIDOR AO SUPABASE.
 *
 * O `fetch` do Node não tem prazo próprio que valha aqui, e o SDK do Supabase não
 * põe nenhum. Em 15/10/2026, na VPS Locaweb, o app ficou minutos com toda
 * consulta ao Supabase pendurada — health "tempo_esgotado", telas em esqueleto,
 * "Erro inesperado" na ação — enquanto um processo novo no mesmo container
 * respondia em 230ms; só o reinício devolveu. Com prazo, a chamada pendurada vira
 * erro (que a tela mostra e a próxima tentativa supera) em vez de espera eterna,
 * e o log diz qual caminho travou.
 *
 * Storage leva mais folga: sobe e baixa mídia.
 *
 * Chamada SEM `signal` não ganha um: `signal` desliga a deduplicação do Next
 * dentro do render (`tests/unit/memo-da-instalacao-fora-do-dedupe-do-render`), e
 * pôr um em toda chamada mandaria ao banco cada GET repetido do render. Nela o
 * prazo é uma corrida contra o cronômetro: quem chamou recebe o erro na hora, e
 * a requisição pendurada morre com o socket. Com `signal`, os dois se somam.
 */
const PRAZO_MS = 20_000;
const PRAZO_STORAGE_MS = 60_000;

function comPrazo(alvo: string, init: RequestInit | undefined, fazer: (init: RequestInit) => Promise<Response>) {
  const ms = alvo.includes("/storage/v1/") ? PRAZO_STORAGE_MS : PRAZO_MS;
  const inicio = Date.now();
  let estourou = false;
  let cronometro: ReturnType<typeof setTimeout> | undefined;
  const chamada = init?.signal
    ? (() => {
        const prazo = AbortSignal.timeout(ms);
        prazo.addEventListener("abort", () => (estourou = true));
        return fazer({ ...init, signal: AbortSignal.any([init.signal, prazo]) });
      })()
    : Promise.race([
        fazer(init ?? {}),
        new Promise<never>((_, rejeitar) => {
          cronometro = setTimeout(() => {
            estourou = true;
            rejeitar(new DOMException(`O Supabase não respondeu em ${ms}ms.`, "TimeoutError"));
          }, ms);
        }),
      ]);
  return chamada.finally(() => clearTimeout(cronometro)).catch((erro: unknown) => {
    if (estourou) {
      let caminho = alvo;
      try {
        caminho = new URL(alvo).pathname; // sem query: pode carregar filtro de dado
      } catch {
        // alvo relativo: segue como veio
      }
      logger.warn("[supabase] chamada do servidor estourou o prazo", {
        caminho,
        prazo_ms: ms,
        decorrido_ms: Date.now() - inicio,
      });
    }
    throw erro;
  });
}

/** Tira a barra que o `.env` pode trazer: `https://x/` + `storage/…` viraria `//`. */
function semBarraFinal(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Cria o fetch que desvia as requisições do SDK para o endereço interno do
 * servidor.
 *
 * `urlInterna` chega JÁ RESOLVIDA (quem chama passa o resultado de
 * `urlDoSupabaseNoServidor`) e `urlPublica` é a mesma `NEXT_PUBLIC_*` que serve
 * de base ao client. Sem variável — ou com um valor que o resolvedor recusou —
 * os dois são iguais e o transporte é exatamente o de antes.
 *
 * A reescrita é LAZY de propósito: `globalThis.fetch` é lido na hora da
 * chamada, nunca na hora de criar o client. É o que permite ao teste trocar o
 * fetch global e observar o destino sem tocar no SDK.
 */
export function fetchDoServidor(urlInterna: string, urlPublica: string): typeof globalThis.fetch {
  const interna = semBarraFinal(urlInterna);
  const publica = semBarraFinal(urlPublica);

  if (!interna || interna === publica) {
    return (input, init) =>
      comPrazo(urlDe(input), init, (comSinal) => globalThis.fetch(input, comSinal));
  }

  const desviar = (alvo: string): string => {
    if (alvo === publica) return interna;
    if (alvo.startsWith(`${publica}/`)) return interna + alvo.slice(publica.length);
    return alvo;
  };

  return (input, init) =>
    comPrazo(urlDe(input), init, (comSinal) => {
      if (typeof input === "string") {
        return globalThis.fetch(desviar(input), comSinal);
      }

      if (input instanceof URL) {
        const destino = desviar(input.href);
        return globalThis.fetch(destino === input.href ? input : new URL(destino), comSinal);
      }

      // O SDK do Supabase sempre passa string; o Request está aqui para o
      // `global.fetch` ser honesto, não para um caso de uso do produto.
      const destino = desviar(input.url);
      if (destino === input.url) return globalThis.fetch(input, comSinal);
      return globalThis.fetch(new Request(destino, input as unknown as RequestInit), comSinal);
    });
}

function urlDe(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
