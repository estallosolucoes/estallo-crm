/**
 * O CAMPO DE MENSAGEM GANHA O FOCO SOZINHO — quando isso ajuda, e só então.
 *
 * Abrir uma conversa (ou escolher "Responder a esta mensagem") obrigava um
 * clique a mais no campo antes de escrever (pedido de 17/10/2026). O foco
 * automático NÃO vale quando:
 *  - o campo está desabilitado (contato bloqueado, conversa encerrada,
 *    suporte só leitura) — focar algo que não aceita texto não serve;
 *  - há um diálogo aberto por cima — roubaria o foco de quem está nele;
 *  - é celular e o gesto foi só ABRIR a conversa — o teclado virtual subiria e
 *    cobriria a mensagem que a pessoa foi ler. Em "Responder" ela pediu para
 *    escrever, então ali o teclado pode abrir.
 *
 * Sem `setTimeout`: quem chama é um efeito, que já roda com o campo montado.
 */
export function focarCampoDeMensagem(
  campo: HTMLTextAreaElement | null,
  { mesmoNoCelular }: { mesmoNoCelular: boolean },
): boolean {
  if (!campo || campo.disabled || typeof document === "undefined") return false;
  const dialogoAberto = document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  if (dialogoAberto && !dialogoAberto.contains(campo)) return false;
  const celular =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
  if (celular && !mesmoNoCelular) return false;
  campo.focus({ preventScroll: true });
  // O texto já digitado fica; o cursor vai para o fim dele.
  const fim = campo.value.length;
  campo.setSelectionRange(fim, fim);
  return true;
}
