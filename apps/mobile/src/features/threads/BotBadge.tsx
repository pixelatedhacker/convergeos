import { memo } from "react";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export const BotBadge = memo(function BotBadge(props: {
  readonly displayName: string;
  readonly selected?: boolean;
}) {
  return (
    <Text
      accessibilityLabel={`Bot: ${props.displayName}`}
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-t3-bold tracking-wide",
        props.selected
          ? "bg-user-bubble-foreground/15 text-user-bubble-foreground"
          : "bg-fill-secondary text-foreground-tertiary",
      )}
    >
      BOT
    </Text>
  );
});
