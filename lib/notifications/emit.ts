import { NOTIFY_KINDS, type NotifyKind } from "./kinds";
import { areAlertsEnabled, getPermission } from "./permission";
import { ensureNotifyServiceWorker } from "./service_worker";
import { playSound, type SoundId } from "./sounds";

const BODY_MAX = 140;

export interface EmitNotificationInput {
  kind: NotifyKind;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  icon?: string;
  sound?: SoundId;
  force?: boolean;
}

export function truncateNotifyBody(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= BODY_MAX) return t;
  return `${t.slice(0, BODY_MAX - 1)}…`;
}

function absUrl(path: string): string {
  if (!path) return "";
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

/**
 * `new Notification()` é o que o Chrome desenha na bandeja; `silent: false`
 * usa o som do SO (AudioContext some com a aba oculta). Se o construtor falha,
 * cai no `showNotification` do service worker.
 */
export function emitNotification(input: EmitNotificationInput): void {
  if (typeof window === "undefined") return;
  const perm = getPermission();
  const enabled = areAlertsEnabled();
  if (!input.force && !enabled) return;

  const spec = NOTIFY_KINDS[input.kind];
  const sound = input.sound ?? spec.sound;

  /**
   * O SOM NÃO DEPENDE DA PERMISSÃO DO SISTEMA.
   *
   * A permissão governa a notificação do SO (a bandeja), não o bipe da aba:
   * antes, quem nunca concedeu a permissão (ou a negou) não ouvia NADA — a
   * verificação vinha antes do som, e o aviso "chegou mensagem" ficava mudo
   * com a aba aberta na frente da pessoa (relatado em 17/10/2026). Com a aba
   * oculta o som é o do SO, que vai junto da notificação (`silent: false`).
   */
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    try {
      playSound(sound, 1.0);
    } catch {
      // AudioContext recusa
    }
  }

  if (perm !== "granted") return;
  const body = truncateNotifyBody(input.body);
  const tag = input.tag ? `${spec.tagPrefix}:${input.tag}` : `${spec.tagPrefix}:${Date.now()}`;
  const marca = absUrl("/icon");
  const icon = absUrl(input.icon || marca);
  const href = input.href ? absUrl(input.href) : "";
  const opts: NotificationOptions & { renotify?: boolean } = {
    body,
    tag,
    silent: false,
    renotify: true,
    icon,
    badge: marca,
    data: { href },
  };

  try {
    const n = new Notification(input.title, opts);
    n.onclick = () => {
      window.focus();
      if (href) window.location.assign(href);
      n.close();
    };
  } catch {
    void showInOsTray(input.title, opts);
  }
}

async function showInOsTray(title: string, opts: NotificationOptions): Promise<void> {
  const reg = await ensureNotifyServiceWorker();
  const ready =
    typeof navigator !== "undefined" && navigator.serviceWorker
      ? await navigator.serviceWorker.ready.catch(() => null)
      : null;
  const alvo = ready ?? reg;
  if (!alvo) return;
  try {
    await alvo.showNotification(title, opts);
  } catch {
    // SW indisponível
  }
}
