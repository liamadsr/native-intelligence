import { cn } from "@/lib/utils";

import type { TEventColor } from "@/calendar/types";

export function EventBullet({ color, className }: { color: TEventColor; className: string }) {
  return <div className={cn("size-2 rounded-full cal-dot", `cal-${color}`, className)} />;
}
