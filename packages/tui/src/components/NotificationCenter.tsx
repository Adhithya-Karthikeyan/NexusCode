/**
 * `<NotificationCenter>` (design spec §2.2 `notifications`, §3.8) — the stacked
 * feed of derived notices (errors + approvals + route/failover). It is a pure
 * selector over the store's `NotificationItem[]` — no state of its own — mapping
 * each item to a `<Toast>` row (error → error, approval → warning). Ships an
 * explicit **empty** state (§1.3.4: no view renders a blank void) and shows the
 * newest `max` items with an `… N earlier` overflow cue.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import type { NotificationItem } from "../store/viewState.js";
import { useColor, useTextStyle } from "../theme/ThemeProvider.js";
import { Icon } from "./Icon.js";
import { Toast, type ToastLevel } from "./Toast.js";

/** Map a store notification kind to a toast severity. */
export function notificationLevel(item: NotificationItem): ToastLevel {
  return item.kind === "error" ? "error" : "warning";
}

export interface NotificationCenterProps {
  items: readonly NotificationItem[];
  /** Show the newest N (default 5); older ones collapse to an overflow cue. */
  max?: number;
  title?: string;
  /** Placeholder shown when there are no notifications. */
  emptyText?: string;
  measure?: (s: string) => number;
}

export function NotificationCenter({
  items,
  max = 5,
  title = "Notifications",
  emptyText = "no notifications",
  measure,
}: NotificationCenterProps): React.JSX.Element {
  const caps = useCaps();
  const titleStyle = useTextStyle("chrome.title");
  const muted = useTextStyle("text.muted");
  const borderColor = useColor("chrome.border");

  // Newest last in the store; show the most recent `max`, newest first.
  const newestFirst = items.slice().reverse();
  const shown = newestFirst.slice(0, max);
  const hidden = newestFirst.length - shown.length;

  return (
    <Box
      flexDirection="column"
      borderStyle={caps.unicode ? "round" : "classic"}
      {...(borderColor ? { borderColor } : {})}
      paddingX={1}
    >
      <Box>
        <Icon name="bell" style={titleStyle} {...(measure ? { measure } : {})} />
        <Text {...titleStyle}> {title}</Text>
        <Text {...muted}> · {items.length}</Text>
      </Box>
      {shown.length === 0 ? (
        <Text {...muted}>· {emptyText}</Text>
      ) : (
        shown.map((item, i) => (
          <Toast
            key={`${item.ts}-${i}`}
            level={notificationLevel(item)}
            title={item.title}
            message={item.detail}
            bordered={false}
            {...(measure ? { measure } : {})}
          />
        ))
      )}
      {hidden > 0 ? <Text {...muted}>… {hidden} earlier</Text> : null}
    </Box>
  );
}
