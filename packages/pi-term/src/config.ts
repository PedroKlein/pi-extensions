import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AppConfig {
	name: string;
	cmd: string;
	key?: string;
	width?: string;
	height?: string;
	anchor?: string;
	closeKey?: string;
	cwd?: string;
	env?: Record<string, string>;
	shell?: string;
	toggle?: boolean;
	holdOnExit?: boolean;
	notify?: boolean;
	feedContext?: string;
	borderColor?: string;
	if?: string;
}

export interface Defaults {
	width: string;
	height: string;
	anchor: string;
	shell: string;
	closeKey: string;
	holdOnExit: boolean;
	toggle: boolean;
	notify: boolean;
	borderColor: string;
}

export interface PiTermConfig {
	defaults: Defaults;
	apps: AppConfig[];
}

export interface ResolvedApp {
	name: string;
	cmd: string;
	key?: string;
	width: string;
	height: string;
	anchor: string;
	closeKey: string;
	cwd?: string;
	env?: Record<string, string>;
	shell: string;
	toggle: boolean;
	holdOnExit: boolean;
	notify: boolean;
	feedContext?: string;
	borderColor: string;
	if?: string;
}

export const DEFAULT_DEFAULTS: Defaults = {
	width: "80%",
	height: "80%",
	anchor: "center",
	shell: process.env.SHELL || "/bin/sh",
	closeKey: "ctrl+q",
	holdOnExit: false,
	toggle: false,
	notify: false,
	borderColor: "accent",
};

async function readJsonFile(path: string): Promise<Partial<PiTermConfig> | null> {
	try {
		const content = await readFile(path, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

export function mergeDefaults(global: Partial<Defaults> | undefined, local: Partial<Defaults> | undefined): Defaults {
	return {
		...DEFAULT_DEFAULTS,
		...(global ?? {}),
		...(local ?? {}),
	};
}

export function mergeApps(globalApps: AppConfig[], localApps: AppConfig[]): AppConfig[] {
	const merged = new Map<string, AppConfig>();
	for (const app of globalApps) {
		merged.set(app.name, app);
	}
	for (const app of localApps) {
		merged.set(app.name, { ...merged.get(app.name), ...app });
	}
	return Array.from(merged.values());
}

export function resolveApp(app: AppConfig, defaults: Defaults): ResolvedApp {
	return {
		name: app.name,
		cmd: app.cmd,
		key: app.key,
		width: app.width ?? defaults.width,
		height: app.height ?? defaults.height,
		anchor: app.anchor ?? defaults.anchor,
		closeKey: app.closeKey ?? defaults.closeKey,
		cwd: app.cwd,
		env: app.env,
		shell: app.shell ?? defaults.shell,
		toggle: app.toggle ?? defaults.toggle,
		holdOnExit: app.holdOnExit ?? defaults.holdOnExit,
		notify: app.notify ?? defaults.notify,
		feedContext: app.feedContext,
		borderColor: app.borderColor ?? defaults.borderColor,
		if: app.if,
	};
}

export async function loadConfig(cwd: string): Promise<{ defaults: Defaults; apps: ResolvedApp[] }> {
	const globalPath = join(homedir(), ".pi", "agent", "pi-term.json");
	const localPath = join(cwd, ".pi", "pi-term.json");

	const globalConfig = await readJsonFile(globalPath);
	const localConfig = await readJsonFile(localPath);

	const defaults = mergeDefaults(globalConfig?.defaults, localConfig?.defaults);
	const apps = mergeApps(globalConfig?.apps ?? [], localConfig?.apps ?? []);
	const resolved = apps.map((app) => resolveApp(app, defaults));

	return { defaults, apps: resolved };
}
