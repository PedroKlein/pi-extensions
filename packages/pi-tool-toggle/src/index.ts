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

  function applyMask(): void {
    pi.setActiveTools(
      pi.getActiveTools().filter((name) => !disabledTools.has(name)),
    );
  }

  function persist(): void {
    pi.appendEntry<ToolToggleState>(STATE_TYPE, {
      disabledTools: [...disabledTools].sort(),
    });
  }

  function restore(ctx: ExtensionContext): void {
    const previouslyDisabled = disabledTools;
    const saved = findSavedState(ctx);
    disabledTools = new Set(saved ?? readDefaultDisabled(ctx));

    const available = new Set(pi.getActiveTools());
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    for (const name of previouslyDisabled) {
      if (registered.has(name)) available.add(name);
    }

    pi.setActiveTools(
      [...available].filter((name) => !disabledTools.has(name)),
    );
  }

  function setDisabled(name: string, disabled: boolean): void {
    if (disabled) {
      disabledTools.add(name);
      applyMask();
    } else {
      disabledTools.delete(name);
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

      const items: SettingItem[] = pi.getAllTools().map((tool) => ({
        id: tool.name,
        label: tool.name,
        currentValue: disabledTools.has(tool.name) ? "disabled" : "enabled",
        values: ["enabled", "disabled"],
      }));

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
