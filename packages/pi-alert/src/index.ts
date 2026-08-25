import { platform } from "node:os"
import { basename } from "node:path"
import {
  getAgentDir,
  SettingsManager,
  type AgentEndEvent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"

const APP_NAME = "pi"
const FALLBACK_MESSAGE = "Agent finished its turn"
const NOTIFICATION_TIMEOUT_MS = 5_000
const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty"

export type NotificationCommand = {
  command: string
  args: string[]
}

export type TerminalNotificationTransport = "osc777" | "osc99" | "osc9"

export type TerminalNotificationTarget = {
  transport: TerminalNotificationTransport
  viaTmux: boolean
}

export type TerminalWriter = {
  isTTY?: boolean
  write(chunk: string): unknown
}

export type AlertSummaryInput = {
  elapsedMs: number | null
  writeCount: number
  writtenPaths: string[]
  readCount: number
  readPaths: string[]
  otherToolCalls: string[]
}

type PendingToolCall = {
  toolName: string
  path: string | null
}

type AlertRunState = {
  startedAt: number
  pendingToolCalls: Map<string, PendingToolCall>
  writeCount: number
  writtenPaths: Set<string>
  readCount: number
  readPaths: Set<string>
  otherToolCalls: string[]
}

type AlertSettings = ReturnType<SettingsManager["getGlobalSettings"]> & {
  "pi-alert"?: {
    toolAlerts?: Record<string, unknown>
  }
}

export default function alertExtension(pi: ExtensionAPI) {
  let currentRun: AlertRunState | null = null
  let toolAlerts = new Map<string, string>()

  pi.on("session_start", (_event, ctx) => {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    })
    const global = settings.getGlobalSettings() as AlertSettings
    const project = settings.getProjectSettings() as AlertSettings
    const configured = {
      ...global["pi-alert"]?.toolAlerts,
      ...project["pi-alert"]?.toolAlerts,
    }

    toolAlerts = new Map(
      Object.entries(configured).filter(
        (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string",
      ),
    )
  })

  pi.on("agent_start", () => {
    currentRun = createRunState(Date.now())
  })

  pi.on("tool_execution_start", (event, ctx) => {
    const alertMessage = toolAlerts.get(event.toolName)
    if (alertMessage) {
      void notifyBestAvailable(pi, buildAlertTitle(ctx.cwd), alertMessage).catch(() => {})
    }

    if (!currentRun) {
      return
    }

    currentRun.pendingToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      path: getPathArg(event.args),
    })
  })

  pi.on("tool_execution_end", (event) => {
    if (!currentRun) {
      return
    }

    const pendingToolCall = currentRun.pendingToolCalls.get(event.toolCallId)
    currentRun.pendingToolCalls.delete(event.toolCallId)

    if (event.isError) {
      return
    }

    recordCompletedToolExecution(currentRun, pendingToolCall?.toolName ?? event.toolName, pendingToolCall?.path ?? null)
  })

  pi.on("agent_end", async (event, ctx) => {
    const liveSummary = snapshotRunState(currentRun)
    const fallbackSummary = summarizeAgentEndMessages(event.messages)
    const message = buildAlertMessage(mergeAlertSummaries(liveSummary, fallbackSummary))
    const title = buildAlertTitle(ctx.cwd)

    currentRun = null
    await notifyBestAvailable(pi, title, message)
  })
}

function createRunState(startedAt: number): AlertRunState {
  return {
    startedAt,
    pendingToolCalls: new Map<string, PendingToolCall>(),
    writeCount: 0,
    writtenPaths: new Set<string>(),
    readCount: 0,
    readPaths: new Set<string>(),
    otherToolCalls: [],
  }
}

function snapshotRunState(run: AlertRunState | null): AlertSummaryInput {
  return {
    elapsedMs: run ? Math.max(0, Date.now() - run.startedAt) : null,
    writeCount: run?.writeCount ?? 0,
    writtenPaths: run ? [...run.writtenPaths] : [],
    readCount: run?.readCount ?? 0,
    readPaths: run ? [...run.readPaths] : [],
    otherToolCalls: run ? [...run.otherToolCalls] : [],
  }
}

function recordCompletedToolExecution(run: AlertRunState, toolName: string, path: string | null): void {
  switch (toolName) {
    case "write":
    case "edit":
      run.writeCount += 1
      if (path) {
        run.writtenPaths.add(path)
      }
      return

    case "read":
      run.readCount += 1
      if (path) {
        run.readPaths.add(path)
      }
      return

    default:
      run.otherToolCalls.push(toolName)
      return
  }
}

export function summarizeAgentEndMessages(messages: AgentEndEvent["messages"]): AlertSummaryInput {
  const summary: AlertSummaryInput = {
    elapsedMs: null,
    writeCount: 0,
    writtenPaths: [],
    readCount: 0,
    readPaths: [],
    otherToolCalls: [],
  }

  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError) {
      continue
    }

    switch (message.toolName) {
      case "write":
      case "edit":
        summary.writeCount += 1
        break

      case "read":
        summary.readCount += 1
        break

      default:
        summary.otherToolCalls.push(message.toolName)
        break
    }
  }

  return summary
}

export function mergeAlertSummaries(primary: AlertSummaryInput, fallback: AlertSummaryInput): AlertSummaryInput {
  const hasPrimaryWrites = primary.writeCount > 0 || primary.writtenPaths.length > 0
  const hasPrimaryReads = primary.readCount > 0 || primary.readPaths.length > 0

  return {
    elapsedMs: primary.elapsedMs ?? fallback.elapsedMs,
    writeCount: hasPrimaryWrites ? primary.writeCount : fallback.writeCount,
    writtenPaths: hasPrimaryWrites ? primary.writtenPaths : fallback.writtenPaths,
    readCount: hasPrimaryReads ? primary.readCount : fallback.readCount,
    readPaths: hasPrimaryReads ? primary.readPaths : fallback.readPaths,
    otherToolCalls: primary.otherToolCalls.length > 0 ? primary.otherToolCalls : fallback.otherToolCalls,
  }
}

async function notifyBestAvailable(pi: ExtensionAPI, title: string, message: string): Promise<void> {
  const preferredCommands = buildPreferredNotificationCommands(platform(), process.env, title, message)
  if (await execFirstAvailable(pi, preferredCommands)) {
    return
  }

  const target = await detectTerminalNotificationTarget(pi, process.env, process.stdout.isTTY === true)
  if (sendTerminalNotification(title, message, process.env, process.stdout, target)) {
    return
  }

  if (await notifyCurrentPlatform(pi, title, message)) {
    return
  }

  sendTerminalBell(process.stdout)
}

export function sendTerminalNotification(
  title: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  writer: TerminalWriter = process.stdout,
  target: TerminalNotificationTarget | null = detectTerminalNotificationTargetFromEnv(env, writer.isTTY === true),
): boolean {
  if (!target) {
    return false
  }

  const sequences = buildTerminalNotificationSequences(target.transport, title, message).map((sequence) =>
    target.viaTmux ? wrapTmuxPassthroughSequence(sequence) : sequence,
  )

  for (const sequence of sequences) {
    writer.write(sequence)
  }

  return true
}

export function detectTerminalNotificationTransport(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): TerminalNotificationTransport | null {
  return detectTerminalNotificationTargetFromEnv(env, isTTY)?.transport ?? null
}

export function detectTerminalNotificationTargetFromEnv(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): TerminalNotificationTarget | null {
  if (!isTTY) {
    return null
  }

  const transport = detectTerminalNotificationTransportFromTerminalMetadata({
    kittyWindowId: env.KITTY_WINDOW_ID,
    itermSessionId: env.ITERM_SESSION_ID,
    lcTerminal: env.LC_TERMINAL,
    termProgram: env.TERM_PROGRAM,
    term: env.TERM,
  })

  if (!transport) {
    return null
  }

  return {
    transport,
    viaTmux: typeof env.TMUX === "string" && env.TMUX.length > 0,
  }
}

async function detectTerminalNotificationTarget(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): Promise<TerminalNotificationTarget | null> {
  const directTarget = detectTerminalNotificationTargetFromEnv(env, isTTY)
  if (directTarget && !directTarget.viaTmux) {
    return directTarget
  }

  if (!isTTY || !env.TMUX) {
    return directTarget
  }

  if (!(await isTmuxPassthroughEnabled(pi))) {
    return null
  }

  const tmuxTransport = await detectTmuxTerminalNotificationTransport(pi)
  if (!tmuxTransport) {
    return null
  }

  return {
    transport: tmuxTransport,
    viaTmux: true,
  }
}

async function detectTmuxTerminalNotificationTransport(pi: ExtensionAPI): Promise<TerminalNotificationTransport | null> {
  try {
    const result = await pi.exec(
      "tmux",
      ["display-message", "-p", "#{client_termname}\n#{client_termtype}"],
      { timeout: 1_000 },
    )

    if (result.code !== 0) {
      return null
    }

    const [clientTermName = "", clientTermType = ""] = result.stdout.split(/\r?\n/, 2)
    return detectTerminalNotificationTransportFromTerminalMetadata({
      termProgram: clientTermName,
      term: clientTermType,
    })
  } catch {
    return null
  }
}

async function isTmuxPassthroughEnabled(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("tmux", ["show", "-gv", "allow-passthrough"], { timeout: 1_000 })
    if (result.code !== 0) {
      return false
    }

    return parseTmuxAllowPassthrough(result.stdout)
  } catch {
    return false
  }
}

export function parseTmuxAllowPassthrough(output: string): boolean {
  return output.trim().toLowerCase() === "on"
}

function detectTerminalNotificationTransportFromTerminalMetadata(metadata: {
  kittyWindowId?: string | undefined
  itermSessionId?: string | undefined
  lcTerminal?: string | undefined
  termProgram?: string | undefined
  term?: string | undefined
}): TerminalNotificationTransport | null {
  if (metadata.kittyWindowId) {
    return "osc99"
  }

  if (metadata.itermSessionId) {
    return "osc9"
  }

  const lcTerminal = metadata.lcTerminal?.toLowerCase()
  if (lcTerminal === "iterm2") {
    return "osc9"
  }

  const termProgram = metadata.termProgram?.toLowerCase()
  if (termProgram === "iterm.app") {
    return "osc9"
  }

  if (termProgram === "ghostty" || termProgram === "wezterm") {
    return "osc777"
  }

  const term = metadata.term?.toLowerCase() ?? ""
  if (term.includes("kitty")) {
    return "osc99"
  }

  if (term.includes("iterm")) {
    return "osc9"
  }

  if (term.includes("ghostty") || term.includes("wezterm") || term.includes("rxvt")) {
    return "osc777"
  }

  return null
}

export function buildTerminalNotificationSequences(
  transport: TerminalNotificationTransport,
  title: string,
  message: string,
): string[] {
  const safeTitle = sanitizeTerminalNotificationText(title)
  const safeMessage = sanitizeTerminalNotificationText(message)

  switch (transport) {
    case "osc777":
      return [buildOsc777Sequence(safeTitle, safeMessage)]

    case "osc99":
      return buildOsc99Sequences(safeTitle, safeMessage)

    case "osc9":
      return [buildOsc9Sequence(formatOsc9Message(safeTitle, safeMessage))]
  }
}

export function buildOsc777Sequence(title: string, message: string): string {
  return `\x1b]777;notify;${title};${message}\x07`
}

export function buildOsc9Sequence(message: string): string {
  return `\x1b]9;${message}\x07`
}

export function buildOsc99Sequences(title: string, message: string): [string, string] {
  return [`\x1b]99;i=1:d=0;${title}\x1b\\`, `\x1b]99;i=1:p=body;${message}\x1b\\`]
}

function formatOsc9Message(title: string, message: string): string {
  return `${title}: ${message}`
}

export function wrapTmuxPassthroughSequence(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
}

export function sanitizeTerminalNotificationText(value: string): string {
  return value.replaceAll(/[\u0000-\u001f\u007f]+/g, " ").trim()
}

export function sendTerminalBell(writer: TerminalWriter = process.stdout): boolean {
  if (writer.isTTY !== true) {
    return false
  }

  writer.write("\x07")
  return true
}

async function notifyCurrentPlatform(pi: ExtensionAPI, title: string, message: string): Promise<boolean> {
  const commands = buildNotificationCommands(platform(), title, message)
  return execFirstAvailable(pi, commands)
}

export function buildPreferredNotificationCommands(
  targetPlatform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  title: string,
  message: string,
): NotificationCommand[] {
  const termProgram = env.TERM_PROGRAM?.toLowerCase()
  const term = env.TERM?.toLowerCase() ?? ""
  if (targetPlatform !== "darwin" || (termProgram !== "ghostty" && !term.includes("ghostty"))) {
    return []
  }

  return [
    {
      command: "osascript",
      args: [
        "-e",
        `tell application id "${GHOSTTY_BUNDLE_ID}" to display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`,
      ],
    },
  ]
}

export function buildNotificationCommands(
  targetPlatform: NodeJS.Platform,
  title: string,
  message: string,
): NotificationCommand[] {
  switch (targetPlatform) {
    case "darwin":
      return [
        {
          command: "osascript",
          args: [
            "-e",
            `display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`,
          ],
        },
      ]

    case "linux":
      return [
        {
          command: "notify-send",
          args: ["--app-name=pi", `--expire-time=${NOTIFICATION_TIMEOUT_MS}`, title, message],
        },
      ]

    case "win32":
      return [
        {
          command: "powershell",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            buildWindowsNotificationScript(title, message),
          ],
        },
        {
          command: "pwsh",
          args: ["-NoProfile", "-NonInteractive", "-Command", buildWindowsNotificationScript(title, message)],
        },
      ]

    default:
      return []
  }
}

async function execFirstAvailable(pi: ExtensionAPI, commands: NotificationCommand[]): Promise<boolean> {
  for (const command of commands) {
    if (await tryCommand(pi, command)) {
      return true
    }
  }

  return false
}

async function tryCommand(pi: ExtensionAPI, command: NotificationCommand): Promise<boolean> {
  try {
    const result = await pi.exec(command.command, command.args, { timeout: NOTIFICATION_TIMEOUT_MS })
    return result.code === 0
  } catch {
    return false
  }
}

function getPathArg(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null
  }

  const path = "path" in args ? args.path : undefined
  if (typeof path !== "string") {
    return null
  }

  return normalizeToolPath(path)
}

function normalizeToolPath(path: string): string | null {
  const normalizedPath = path.trim().replace(/^@/, "")
  return normalizedPath ? normalizedPath : null
}

export function buildAlertTitle(cwd: string | null | undefined): string {
  if (!cwd) {
    return APP_NAME
  }

  const normalizedCwd = cwd.replace(/[\\/]+$/, "") || cwd
  const rootDir = basename(normalizedCwd)
  return rootDir ? `${APP_NAME} — ${rootDir}` : APP_NAME
}

export function buildAlertMessage(summary: AlertSummaryInput): string {
  const durationSuffix = summary.elapsedMs === null ? "" : ` in ${formatDuration(summary.elapsedMs)}`
  const writeFileCount = summary.writtenPaths.length > 0 ? summary.writtenPaths.length : summary.writeCount
  const readFileCount = summary.readPaths.length > 0 ? summary.readPaths.length : summary.readCount

  if (writeFileCount > 0) {
    return `${describeFileActivity("Updated", writeFileCount)}${durationSuffix}`
  }

  if (summary.otherToolCalls.length > 0) {
    return `${describeOtherToolActivity(summary.otherToolCalls)}${durationSuffix}`
  }

  if (readFileCount > 0) {
    return `${describeFileActivity("Read", readFileCount)}${durationSuffix}`
  }

  return durationSuffix ? `Finished${durationSuffix}` : FALLBACK_MESSAGE
}

function describeFileActivity(verb: string, count: number): string {
  return `${verb} ${count} ${count === 1 ? "file" : "files"}`
}

function describeOtherToolActivity(toolCalls: string[]): string {
  const formattedToolCalls = toolCalls.map(formatToolName)
  const uniqueToolCalls = [...new Set(formattedToolCalls)]

  if (toolCalls.length === 1) {
    return `Ran ${uniqueToolCalls[0]}`
  }

  if (uniqueToolCalls.length === 1) {
    return `Ran ${toolCalls.length} ${uniqueToolCalls[0]} calls`
  }

  const preview = uniqueToolCalls.slice(0, 2).join(", ")
  const overflow = uniqueToolCalls.length > 2 ? ", ..." : ""
  return `Ran ${toolCalls.length} tool calls (${preview}${overflow})`
}

function formatToolName(toolName: string): string {
  return toolName.replaceAll(/[-_]+/g, " ")
}

export function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`
  }

  const seconds = elapsedMs / 1_000
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`
  }

  const totalMinutes = Math.floor(seconds / 60)
  if (totalMinutes < 60) {
    const remainingSeconds = Math.round(seconds % 60)
    return `${totalMinutes}m ${remainingSeconds}s`
  }

  const hours = Math.floor(totalMinutes / 60)
  const remainingMinutes = totalMinutes % 60
  return `${hours}h ${remainingMinutes}m`
}

export function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

export function escapePowerShellString(value: string): string {
  return value.replaceAll("'", "''")
}

export function buildWindowsNotificationScript(title: string, message: string): string {
  const escapedTitle = escapePowerShellString(title)
  const escapedMessage = escapePowerShellString(message)

  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$notification = New-Object System.Windows.Forms.NotifyIcon",
    "$notification.Icon = [System.Drawing.SystemIcons]::Information",
    "$notification.Visible = $true",
    `$notification.ShowBalloonTip(3000, '${escapedTitle}', '${escapedMessage}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Milliseconds 4000",
    "$notification.Dispose()",
  ].join("; ")
}
