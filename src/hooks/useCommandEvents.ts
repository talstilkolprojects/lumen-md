/**
 * Other UIs run a palette command by id (`lumen-run-command`, e.g. the
 * suggestions panel), and the usage dialog (plan W4.26) asks for every
 * command id (`lumen-open-usage`). W6.25: moved out of App.tsx unchanged.
 */
import { useEffect, useRef } from "react";
import type { Command } from "../ui/CommandPalette";
import { announceCommand } from "../research/usability/commandEvents";
import { countCommand } from "../metrics/count";

export function useCommandEvents(commands: Command[]): void {
  // The suggestions panel (and other UIs) re-run a palette command by id.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  useEffect(() => {
    const onRun = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      const find = (list: typeof commands): (typeof commands)[number] | undefined => {
        for (const c of list) {
          if (c.id === id) return c;
          const child = c.children ? find(c.children as typeof commands) : undefined;
          if (child) return child;
        }
        return undefined;
      };
      const cmd = id ? find(commandsRef.current) : undefined;
      if (cmd) {
        announceCommand(cmd.id);
        countCommand(cmd.id);
        void cmd.action();
      }
    };
    // The usage dialog (plan W4.26) needs every command id to name the unused ones; the beta panel's report (W6.31) names only these.
    const commandIds = () => {
      const ids: string[] = [];
      const walk = (list: typeof commands) => {
        for (const c of list) {
          ids.push(c.id);
          if (c.children) walk(c.children as typeof commands);
        }
      };
      walk(commandsRef.current);
      return ids;
    };
    const onUsage = () => void import("../ui/UsageDialog").then((m) => m.openUsage({ commandIds: commandIds() }));
    const onBeta = () => void import("../ui/BetaPanel").then((m) => m.openBeta({ commandIds: commandIds() }));
    window.addEventListener("lumen-run-command", onRun);
    window.addEventListener("lumen-open-usage", onUsage);
    window.addEventListener("lumen-open-beta", onBeta);
    return () => {
      window.removeEventListener("lumen-run-command", onRun);
      window.removeEventListener("lumen-open-usage", onUsage);
      window.removeEventListener("lumen-open-beta", onBeta);
    };
  }, []);
}
