import {
  getAgentDir,
  getSettingsListTheme,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";

const STATE_TYPE = "pi-tool-toggle";

type ToolToggleState = {
  disabledTools: string[];
};

type ToolToggleSettings = ReturnType<SettingsManager["getGlobalSettings"]> & {
  "pi-tool-toggle"?: {
    defaultDisabled?: unknown;
  };
};

export default function toolToggle(pi: ExtensionAPI): void {
  let disabledTools = new Set<string>();
  let maskedTools = new Set<string>();

  function applyMask(): void {
    const active = pi.getActiveTools();
    const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    for (const name of active) {
      const exposure = registered.get(name)?.exposure;
      if (disabledTools.has(name) && (exposure === "direct" || exposure === "model-only")) {
        maskedTools.add(name);
      }
    }
    pi.setActiveTools(active.filter((name) => !disabledTools.has(name)));
  }

  function persist(): void {
    pi.appendEntry<ToolToggleState>(STATE_TYPE, {
      disabledTools: [...disabledTools].sort(),
    });
  }

  function restore(ctx: ExtensionContext): void {
    const saved = findSavedState(ctx);
    disabledTools = new Set(saved ?? readDefaultDisabled(ctx));

    const available = new Set(pi.getActiveTools());
    const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    for (const name of maskedTools) {
      if (!disabledTools.has(name) && registered.get(name)?.exposure !== "hidden") {
        available.add(name);
      }
    }
    maskedTools = new Set([...maskedTools].filter((name) => disabledTools.has(name)));
    for (const name of available) {
      if (disabledTools.has(name)) maskedTools.add(name);
    }

    pi.setActiveTools([...available].filter((name) => !disabledTools.has(name)));
  }

  function setDisabled(name: string, disabled: boolean): void {
    if (disabled) {
      disabledTools.add(name);
      applyMask();
    } else {
      disabledTools.delete(name);
      maskedTools.delete(name);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), name])]);
    }
    persist();
  }

  pi.registerCommand("tools", {
    description: "Enable or disable tools for this session",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }

      const active = new Set(pi.getActiveTools());
      const items: SettingItem[] = pi.getAllTools().map((tool) => {
        const currentValue = disabledTools.has(tool.name)
          ? "disabled"
          : exposureState(tool.exposure, active.has(tool.name));
        return {
          id: tool.name,
          label: tool.name,
          description: `${tool.exposure} exposure`,
          currentValue,
          values: tool.exposure === "hidden"
            ? undefined
            : [currentValue, activeState(tool.exposure), "disabled"].filter(
              (value, index, values) => values.indexOf(value) === index,
            ),
        };
      });

      await ctx.ui.custom((_tui, _theme, _keybindings, done) =>
        new SettingsList(
          items,
          Math.min(items.length, 15),
          getSettingsListTheme(),
          (name, value) => setDisabled(name, value === "disabled"),
          () => done(undefined),
          { enableSearch: true },
        ),
      );
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("input", () => applyMask());
}

function activeState(
  exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden",
): string {
  return exposure === "model-only" ? "declared" : "declared, callable";
}

function exposureState(
  exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden",
  active: boolean,
): string {
  if (active) return activeState(exposure);
  if (exposure === "codemode") return "callable";
  if (exposure === "deferred") return "deferred, callable";
  return "registered";
}

function findSavedState(ctx: ExtensionContext): string[] | undefined {
  let saved: string[] | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const disabledTools = (entry.data as Partial<ToolToggleState> | undefined)?.disabledTools;
    if (Array.isArray(disabledTools)) {
      saved = disabledTools.filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      );
    }
  }
  return saved;
}

function readDefaultDisabled(ctx: ExtensionContext): string[] {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  }).getGlobalSettings() as ToolToggleSettings;
  const configured = settings[STATE_TYPE]?.defaultDisabled;
  if (!Array.isArray(configured)) return [];
  return configured.filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
}
