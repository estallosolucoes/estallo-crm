"use client";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clock } from "@/lib/ui/icons";
import { useSnoozeConversation } from "@/hooks/inbox/useSnoozeConversation";

interface Props {
  conversationId: string;
  snoozeUntil: string | null;
  disabled?: boolean;
  /** Item do "⋯" do cabeçalho do chat (16/10/2026): submenu com as mesmas durações. */
  comoItemDeMenu?: boolean;
}

const DURATIONS: Array<{ hours: 1 | 3 | 24; label: string }> = [
  { hours: 1, label: "Em 1 hora" },
  { hours: 3, label: "Em 3 horas" },
  { hours: 24, label: "Em 24 horas" },
];

function isSnoozeActive(snoozeUntil: string | null): boolean {
  return snoozeUntil != null && new Date(snoozeUntil).getTime() > Date.now();
}

export function SnoozeButton({ conversationId, snoozeUntil, disabled, comoItemDeMenu = false }: Props) {
  const t = useT();
  const { snooze, cancel } = useSnoozeConversation();
  const isActive = isSnoozeActive(snoozeUntil);
  const isPending = snooze.isPending || cancel.isPending;

  if (comoItemDeMenu) {
    return isActive ? (
      <DropdownMenuItem
        className="ibx-menu-item"
        disabled={disabled || isPending}
        onSelect={() => cancel.mutate({ conversation_id: conversationId })}
      >
        <Clock className="ibx-icon" aria-hidden />
        {t("Cancelar lembrete")}
      </DropdownMenuItem>
    ) : (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="ibx-menu-item" disabled={disabled || isPending}>
          <Clock className="ibx-icon" aria-hidden />
          {t("Lembrar")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="ibx ibx-floating ibx-menu">
          {DURATIONS.map((d) => (
            <DropdownMenuItem
              key={d.hours}
              className="ibx-menu-item"
              onSelect={() =>
                snooze.mutate({ conversation_id: conversationId, duration_hours: d.hours })
              }
            >
              {t(d.label)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || isPending}
          className="flex items-center gap-1"
        >
          <Clock size={12} weight="regular" aria-hidden />
          {isActive ? t("Lembrete ativo") : t("Lembrar")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isActive ? (
          <DropdownMenuItem
            onClick={() => cancel.mutate({ conversation_id: conversationId })}
          >
            {t("Cancelar lembrete")}
          </DropdownMenuItem>
        ) : (
          DURATIONS.map((d) => (
            <DropdownMenuItem
              key={d.hours}
              onClick={() =>
                snooze.mutate({ conversation_id: conversationId, duration_hours: d.hours })
              }
            >
              {t(d.label)}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
