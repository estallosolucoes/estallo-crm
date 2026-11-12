"use client";
import { AlertsBell } from "./AlertsBell";
import { AvisoDePropostaEmDestaque } from "./AvisoDePropostaEmDestaque";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  const { user, activeOrg } = useAuth();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur md:gap-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <TenantSwitcher />
        {user.organizations.length <= 1 && !user.is_platform_admin && activeOrg && (
          <span
            className="max-w-20 truncate text-sm font-semibold sm:max-w-40 md:max-w-56"
            title={activeOrg.name}
          >
            {activeOrg.name}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AlertsBell />
        <AvisoDePropostaEmDestaque />
        <UserMenu />
      </div>
    </header>
  );
}
