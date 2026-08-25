import { describe, expect, test } from "vitest"
import {
  buildAlertMessage,
  buildAlertTitle,
  buildNotificationCommands,
  buildPreferredNotificationCommands,
  buildOsc777Sequence,
  buildOsc9Sequence,
  buildOsc99Sequences,
  buildTerminalNotificationSequences,
  buildWindowsNotificationScript,
  detectTerminalNotificationTargetFromEnv,
  detectTerminalNotificationTransport,
  escapeAppleScriptString,
  escapePowerShellString,
  formatDuration,
  parseTmuxAllowPassthrough,
  mergeAlertSummaries,
  sanitizeTerminalNotificationText,
  sendTerminalBell,
  sendTerminalNotification,
  summarizeAgentEndMessages,
  wrapTmuxPassthroughSequence,
} from "../../src/index.js"

describe("terminal notifications", () => {
  test("detects OSC 777 terminals", () => {
    expect(detectTerminalNotificationTransport({ TERM_PROGRAM: "ghostty" }, true)).toBe("osc777")
    expect(detectTerminalNotificationTransport({ TERM_PROGRAM: "WezTerm" }, true)).toBe("osc777")
    expect(detectTerminalNotificationTransport({ TERM: "rxvt-unicode-256color" }, true)).toBe("osc777")
  })

  test("detects iTerm2", () => {
    expect(detectTerminalNotificationTransport({ TERM_PROGRAM: "iTerm.app" }, true)).toBe("osc9")
    expect(detectTerminalNotificationTransport({ ITERM_SESSION_ID: "w0t0p0" }, true)).toBe("osc9")
    expect(detectTerminalNotificationTransport({ LC_TERMINAL: "iTerm2" }, true)).toBe("osc9")
  })

  test("detects Kitty", () => {
    expect(detectTerminalNotificationTransport({ KITTY_WINDOW_ID: "12" }, true)).toBe("osc99")
  })

  test("marks terminal notifications for tmux passthrough when supported", () => {
    expect(detectTerminalNotificationTargetFromEnv({ TERM_PROGRAM: "ghostty", TMUX: "1" }, true)).toEqual({
      transport: "osc777",
      viaTmux: true,
    })

    expect(detectTerminalNotificationTargetFromEnv({ KITTY_WINDOW_ID: "12", TMUX: "1" }, true)).toEqual({
      transport: "osc99",
      viaTmux: true,
    })
  })

  test("returns null when stdout is not a tty or terminal is unsupported", () => {
    expect(detectTerminalNotificationTransport({ TERM_PROGRAM: "ghostty" }, false)).toBeNull()
    expect(detectTerminalNotificationTransport({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBeNull()
  })

  test("sanitizes terminal notification text", () => {
    expect(sanitizeTerminalNotificationText("line 1\nline 2\u0007")).toBe("line 1 line 2")
  })

  test("builds OSC 777 and OSC 99 sequences", () => {
    expect(buildOsc777Sequence("pi", "done")).toBe("\x1b]777;notify;pi;done\x07")
    expect(buildOsc9Sequence("pi: done")).toBe("\x1b]9;pi: done\x07")
    expect(buildOsc99Sequences("pi", "done")).toEqual([
      "\x1b]99;i=1:d=0;pi\x1b\\",
      "\x1b]99;i=1:p=body;done\x1b\\",
    ])
  })

  test("builds terminal notification sequences for each protocol", () => {
    expect(buildTerminalNotificationSequences("osc777", "pi", "done")).toEqual(["\x1b]777;notify;pi;done\x07"])
    expect(buildTerminalNotificationSequences("osc9", "pi", "done")).toEqual(["\x1b]9;pi: done\x07"])
    expect(buildTerminalNotificationSequences("osc99", "pi", "done")).toEqual([
      "\x1b]99;i=1:d=0;pi\x1b\\",
      "\x1b]99;i=1:p=body;done\x1b\\",
    ])
  })

  test("wraps OSC sequences for tmux passthrough", () => {
    expect(wrapTmuxPassthroughSequence("\x1b]777;notify;pi;done\x07")).toBe(
      "\x1bPtmux;\x1b\x1b]777;notify;pi;done\x07\x1b\\",
    )
  })

  test("writes a terminal notification when supported", () => {
    const writes: string[] = []
    const writer = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(sendTerminalNotification("pi", "done", { TERM_PROGRAM: "ghostty" }, writer)).toBe(true)
    expect(writes).toEqual(["\x1b]777;notify;pi;done\x07"])
  })

  test("writes tmux passthrough sequences when requested", () => {
    const writes: string[] = []
    const writer = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(
      sendTerminalNotification("pi", "done", { TERM_PROGRAM: "tmux", TMUX: "1" }, writer, {
        transport: "osc777",
        viaTmux: true,
      }),
    ).toBe(true)

    expect(writes).toEqual(["\x1bPtmux;\x1b\x1b]777;notify;pi;done\x07\x1b\\"])
  })

  test("falls back when no supported terminal transport is available", () => {
    const writes: string[] = []
    const writer = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(sendTerminalNotification("pi", "done", { TERM_PROGRAM: "Apple_Terminal" }, writer)).toBe(false)
    expect(writes).toEqual([])
  })

  test("rings the terminal bell as a last-resort fallback", () => {
    const writes: string[] = []
    const writer = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(sendTerminalBell(writer)).toBe(true)
    expect(writes).toEqual(["\x07"])
  })

  test("does not ring the terminal bell when stdout is not a tty", () => {
    const writes: string[] = []
    const writer = {
      isTTY: false,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(sendTerminalBell(writer)).toBe(false)
    expect(writes).toEqual([])
  })
})

describe("escapeAppleScriptString", () => {
  test("escapes backslashes and double quotes", () => {
    expect(escapeAppleScriptString('say "hi" \\ now')).toBe('say \\"hi\\" \\\\ now')
  })
})

describe("escapePowerShellString", () => {
  test("escapes single quotes", () => {
    expect(escapePowerShellString("Max's pi")).toBe("Max''s pi")
  })
})

describe("buildWindowsNotificationScript", () => {
  test("embeds escaped title and message", () => {
    const script = buildWindowsNotificationScript("pi's title", "done's message")

    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms")
    expect(script).toContain("'pi''s title'")
    expect(script).toContain("'done''s message'")
    expect(script).toContain("$notification.ShowBalloonTip(3000")
  })
})

describe("buildAlertTitle", () => {
  test("formats the title with the project root directory name", () => {
    expect(buildAlertTitle("/Users/max/dev/pi-alert")).toBe("pi — pi-alert")
    expect(buildAlertTitle("/Users/max/dev/pi-alert/")).toBe("pi — pi-alert")
    expect(buildAlertTitle(undefined)).toBe("pi")
  })
})

describe("parseTmuxAllowPassthrough", () => {
  test("detects whether tmux passthrough is enabled", () => {
    expect(parseTmuxAllowPassthrough("on\n")).toBe(true)
    expect(parseTmuxAllowPassthrough("off\n")).toBe(false)
  })
})

describe("formatDuration", () => {
  test("formats milliseconds, seconds, minutes, and hours", () => {
    expect(formatDuration(850)).toBe("850ms")
    expect(formatDuration(1_250)).toBe("1s")
    expect(formatDuration(14_900)).toBe("14s")
    expect(formatDuration(65_000)).toBe("1m 5s")
    expect(formatDuration(3_600_000)).toBe("1h 0m")
    expect(formatDuration(3_990_000)).toBe("1h 6m")
  })
})

describe("buildAlertMessage", () => {
  test("prioritizes updated files over every other activity", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 1_250,
        writeCount: 2,
        writtenPaths: ["src/alert.ts"],
        readCount: 4,
        readPaths: ["README.md", "package.json"],
        otherToolCalls: ["bash", "grep"],
      }),
    ).toBe("Updated 1 file in 1s")
  })

  test("summarizes other tool calls when nothing was written", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 4_200,
        writeCount: 0,
        writtenPaths: [],
        readCount: 2,
        readPaths: ["README.md"],
        otherToolCalls: ["bash", "grep", "bash"],
      }),
    ).toBe("Ran 3 tool calls (bash, grep) in 4s")
  })

  test("summarizes read activity when it is the highest priority action", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 800,
        writeCount: 0,
        writtenPaths: [],
        readCount: 2,
        readPaths: ["README.md", "package.json"],
        otherToolCalls: [],
      }),
    ).toBe("Read 2 files in 800ms")
  })

  test("falls back to a generic completion message", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 950,
        writeCount: 0,
        writtenPaths: [],
        readCount: 0,
        readPaths: [],
        otherToolCalls: [],
      }),
    ).toBe("Finished in 950ms")
  })
})

describe("summarizeAgentEndMessages", () => {
  test("counts successful tool results by priority bucket", () => {
    const summary = summarizeAgentEndMessages([
      { role: "toolResult", toolCallId: "1", toolName: "read", content: [], isError: false, timestamp: 1 },
      { role: "toolResult", toolCallId: "2", toolName: "edit", content: [], isError: false, timestamp: 2 },
      { role: "toolResult", toolCallId: "3", toolName: "bash", content: [], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "4", toolName: "write", content: [], isError: true, timestamp: 4 },
    ])

    expect(summary).toEqual({
      elapsedMs: null,
      writeCount: 1,
      writtenPaths: [],
      readCount: 1,
      readPaths: [],
      otherToolCalls: ["bash"],
    })
  })
})

describe("mergeAlertSummaries", () => {
  test("uses fallback counts only when live data is missing", () => {
    expect(
      mergeAlertSummaries(
        {
          elapsedMs: 1_500,
          writeCount: 1,
          writtenPaths: ["src/alert.ts"],
          readCount: 0,
          readPaths: [],
          otherToolCalls: [],
        },
        {
          elapsedMs: null,
          writeCount: 2,
          writtenPaths: [],
          readCount: 3,
          readPaths: [],
          otherToolCalls: ["bash"],
        },
      ),
    ).toEqual({
      elapsedMs: 1_500,
      writeCount: 1,
      writtenPaths: ["src/alert.ts"],
      readCount: 3,
      readPaths: [],
      otherToolCalls: ["bash"],
    })
  })
})

describe("buildPreferredNotificationCommands", () => {
  test("uses Ghostty's native macOS identity instead of OSC", () => {
    expect(
      buildPreferredNotificationCommands("darwin", { TERM_PROGRAM: "ghostty" }, "pi", 'hello "world"'),
    ).toEqual([
      {
        command: "osascript",
        args: [
          "-e",
          'tell application id "com.mitchellh.ghostty" to display notification "hello \\"world\\"" with title "pi" sound name "Glass"',
        ],
      },
    ])
  })

  test("does not override other terminals or platforms", () => {
    expect(buildPreferredNotificationCommands("darwin", { TERM_PROGRAM: "iTerm.app" }, "pi", "done")).toEqual([])
    expect(buildPreferredNotificationCommands("linux", { TERM_PROGRAM: "ghostty" }, "pi", "done")).toEqual([])
  })
})

describe("buildNotificationCommands", () => {
  test("builds a macOS notification command", () => {
    expect(buildNotificationCommands("darwin", "pi", 'hello "world"')).toEqual([
      {
        command: "osascript",
        args: ["-e", 'display notification "hello \\"world\\"" with title "pi" sound name "Glass"'],
      },
    ])
  })

  test("builds a Linux notification command", () => {
    expect(buildNotificationCommands("linux", "pi", "done")).toEqual([
      {
        command: "notify-send",
        args: ["--app-name=pi", "--expire-time=5000", "pi", "done"],
      },
    ])
  })

  test("builds Windows notification commands", () => {
    const commands = buildNotificationCommands("win32", "pi", "done")

    expect(commands).toHaveLength(2)
    expect(commands[0]?.command).toBe("powershell")
    expect(commands[1]?.command).toBe("pwsh")
    expect(commands[0]?.args.at(-1)).toContain("$notification.ShowBalloonTip(3000")
  })

  test("returns no commands for unsupported platforms", () => {
    expect(buildNotificationCommands("aix", "pi", "done")).toEqual([])
  })
})
