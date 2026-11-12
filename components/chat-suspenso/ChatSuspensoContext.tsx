"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * O ESTADO DOS CHATS SUSPENSOS — quais conversas estão abertas no canto, qual
 * está à vista e se o conjunto está minimizado.
 *
 * Mora no `AppShell`, que não desmonta ao navegar entre módulos: a conversa
 * aberta a partir do funil continua lá na tela de tarefas. E vai para o
 * `sessionStorage` da aba, para sobreviver a um F5 sem vazar para outra aba.
 *
 * Só o ESTADO mora aqui. Quem desenha é `ChatSuspenso.tsx`; quem só precisa
 * abrir (o card do funil, a lista de tarefas) importa este arquivo leve.
 */

/** Teto de conversas abertas: além disso, a mais antiga que não está à vista sai. */
export const MAXIMO_DE_CHATS = 6;
const CHAVE = "estallo.chat-suspenso";

interface Estado {
  abertos: string[];
  ativo: string | null;
  minimizado: boolean;
}

const VAZIO: Estado = { abertos: [], ativo: null, minimizado: false };

/** Regras puras (testadas em `tests/unit/chat-suspenso-estado.test.ts`). */
export function abrirChat(e: Estado, id: string): Estado {
  if (e.abertos.includes(id)) return { ...e, ativo: id, minimizado: false };
  let abertos = [...e.abertos, id];
  while (abertos.length > MAXIMO_DE_CHATS) {
    const sai = abertos.find((x) => x !== e.ativo && x !== id) ?? abertos[0]!;
    abertos = abertos.filter((x) => x !== sai);
  }
  return { abertos, ativo: id, minimizado: false };
}

/**
 * Trocar de instância é trocar de CONVERSA (uma por contato e número): a nova
 * ocupa a posição da antiga e fica à vista. Se a nova já estava aberta, a
 * antiga só sai — nunca duas entradas para a mesma conversa.
 */
export function substituirChat(e: Estado, antigo: string, novo: string): Estado {
  if (antigo === novo) return { ...e, ativo: novo, minimizado: false };
  const abertos = e.abertos.includes(novo)
    ? e.abertos.filter((x) => x !== antigo)
    : e.abertos.map((x) => (x === antigo ? novo : x));
  return { abertos, ativo: novo, minimizado: false };
}

export function fecharChat(e: Estado, id: string): Estado {
  const abertos = e.abertos.filter((x) => x !== id);
  // Objeto NOVO, não `VAZIO`: fechar o último precisa ser gravado (ver o efeito).
  if (abertos.length === 0) return { ...VAZIO };
  const ativo = e.ativo === id ? abertos[abertos.length - 1]! : e.ativo;
  return { ...e, abertos, ativo };
}

function lerSalvo(): Estado {
  try {
    const bruto = window.sessionStorage.getItem(CHAVE);
    if (!bruto) return VAZIO;
    const salvo = JSON.parse(bruto) as Partial<Estado>;
    const abertos = Array.isArray(salvo.abertos)
      ? salvo.abertos.filter((x): x is string => typeof x === "string").slice(-MAXIMO_DE_CHATS)
      : [];
    if (abertos.length === 0) return VAZIO;
    const ativo = typeof salvo.ativo === "string" && abertos.includes(salvo.ativo) ? salvo.ativo : abertos.at(-1)!;
    return { abertos, ativo, minimizado: salvo.minimizado === true };
  } catch {
    return VAZIO;
  }
}

export interface ChatSuspensoApi extends Estado {
  abrir: (conversationId: string) => void;
  fechar: (conversationId: string) => void;
  alternar: (conversationId: string) => void;
  /** Fecha TODOS os chats abertos (o X do cabeçalho); cada avatar tem o seu X individual. */
  fecharTodos: () => void;
  /** Troca de instância: a conversa do outro número entra no LUGAR da atual. */
  substituir: (antigo: string, novo: string) => void;
  minimizar: () => void;
  restaurar: () => void;
}

const Ctx = createContext<ChatSuspensoApi | null>(null);

export function ProvedorDoChatSuspenso({ children }: { children: ReactNode }) {
  // Começa vazio no servidor e no primeiro render (hidratação idêntica); o
  // salvo entra depois da montagem.
  const [estado, setEstado] = useState<Estado>(VAZIO);
  useEffect(() => {
    const salvo = lerSalvo();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura única do sessionStorage, depois da hidratação
    if (salvo.abertos.length > 0) setEstado(salvo);
  }, []);
  useEffect(() => {
    // O `VAZIO` da hidratação (mesma referência) não é uma escolha do usuário:
    // gravá-lo apagaria o salvo antes de ele ser lido.
    if (estado === VAZIO) return;
    try {
      window.sessionStorage.setItem(CHAVE, JSON.stringify(estado));
    } catch {
      // armazenamento bloqueado: o chat segue funcionando, só não sobrevive ao F5
    }
  }, [estado]);

  const abrir = useCallback((id: string) => setEstado((e) => abrirChat(e, id)), []);
  const fechar = useCallback((id: string) => setEstado((e) => fecharChat(e, id)), []);
  const alternar = useCallback(
    (id: string) => setEstado((e) => (e.abertos.includes(id) ? { ...e, ativo: id } : e)),
    [],
  );
  const minimizar = useCallback(() => setEstado((e) => ({ ...e, minimizado: true })), []);
  const restaurar = useCallback(() => setEstado((e) => ({ ...e, minimizado: false })), []);
  // Objeto novo (não o `VAZIO` da hidratação): fechar tudo precisa ser gravado.
  const fecharTodos = useCallback(() => setEstado({ ...VAZIO }), []);
  const substituir = useCallback(
    (antigo: string, novo: string) => setEstado((e) => substituirChat(e, antigo, novo)),
    [],
  );

  const api = useMemo(
    () => ({ ...estado, abrir, fechar, fecharTodos, alternar, minimizar, restaurar, substituir }),
    [estado, abrir, fechar, fecharTodos, alternar, minimizar, restaurar, substituir],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/**
 * `null` fora do `AppShell` (testes de componente, telas públicas): quem abre
 * o chat cai no comportamento de antes — o link para o Inbox.
 */
export function useChatSuspenso(): ChatSuspensoApi | null {
  return useContext(Ctx);
}
