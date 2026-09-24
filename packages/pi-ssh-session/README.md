# pi-ssh-session

Provides one `ssh_session` tool for approved work through a persistent, non-interactive SSH shell.

## Install

```bash
pi install npm:@pedro_klein/pi-ssh-session
```

The local machine must provide OpenSSH. Authentication uses configured SSH keys or an SSH agent; SSH passwords, key-passphrase prompts, and keyboard-interactive login are not supported. The remote host must provide `bash`. File transfers also require `base64`, and elevated commands require `sudo`.

## Actions

| Action | Parameters | Behavior |
|--------|------------|----------|
| `connect` | `host`, optional `options`, `cacheSudoPassword` | Asks the user to choose prompt or YOLO mode, then starts one `ssh -T` process and a persistent remote `bash -l` shell. `cacheSudoPassword` applies only when YOLO is chosen. Replaces any active connection after validation and approval. |
| `execute` | `command`, optional `timeout` | Runs a command in the active shell. Working directory and exported environment changes persist. Commands beginning with `sudo` are rejected; use `sudo` instead. |
| `status` | none | Reports the active host and approval mode, or that no session is connected. |
| `disconnect` | none | Terminates the active SSH process. |
| `sudo` | `command`, optional `timeout` | Runs the command through non-interactive `sudo` after checking or acquiring a remote sudo timestamp. |
| `upload` | `localPath`, `remotePath`, optional `timeout` | Transfers one local file to the active host. Relative local paths resolve against Pi's current working directory. |
| `download` | `remotePath`, `localPath`, optional `timeout` | Transfers one remote file to the local machine. Relative local paths resolve against Pi's current working directory. |

`timeout` is measured in milliseconds and defaults to 120,000. Connection setup has a 30,000 ms timeout.

## Approval modes

Every connection presents a human choice between prompt and YOLO mode; the agent cannot choose the mode. Prompt mode asks for confirmation before:

- connecting, showing the host and every supplied SSH option;
- executing or running with `sudo`, showing the command;
- uploading or downloading, showing the source and destination.

YOLO mode replaces those repeated confirmations with one explicit warning during `connect`. Approving it authorizes commands, `sudo`, uploads, and downloads on that connection without further confirmation. Use it only when the agent and task are trusted: any of those operations may change the remote or local system without another human checkpoint.

YOLO authorization belongs only to the active SSH process. It ends on disconnect, connection replacement, timeout, abort, stream loss, or Pi shutdown. It is not persisted or restored after reload or resume. Every later connection presents the choice again.

Required approvals fail closed when Pi has no interactive UI. `status` and `disconnect` do not require approval. The extension recommends `ssh_session` for remote work but does not intercept or rewrite Pi's built-in `bash` tool.

## SSH behavior

Connections use these OpenSSH defaults:

```text
-T
-o BatchMode=yes
-o PreferredAuthentications=publickey
-o StrictHostKeyChecking=accept-new
-o ServerAliveInterval=60
-o ServerAliveCountMax=3
```

`accept-new` records previously unseen host keys through the user's normal OpenSSH configuration and rejects changed host keys. `connect.options` accepts complete tokens for `-4`, `-6`, `-a`, `-b`, `-C`, `-c`, `-i`, `-J`, `-l`, `-m`, `-o`, `-p`, `-q`, `-T`, `-v`, and `-x`. Positional arguments and options that enable forwarding, local command execution, control sockets, password authentication, a PTY, or a different remote session are rejected. Option parsing ends before `host`, so a host beginning with `-` remains a host argument.

One SSH process and one remote shell exist per Pi session. Remote commands and transfers are serialized through that shell. Disconnecting, replacing the host, timing out, aborting, losing the stream, or ending the Pi session closes it. Connection state is not restored after reload or resume.

## Output and files

`execute` and `sudo` combine stdout and stderr. Results are limited to 2,000 lines or 50 KiB. When output is truncated, the complete output is written to an owner-only temporary `output.txt` and its path is returned.

Uploads and downloads encode bytes with base64 inside the existing shell; they do not create another SSH connection. Transfer results contain only the host, paths, and byte count. Uploads create or overwrite the remote file, and downloads create or overwrite the local file after a successful remote read. Parent directories must already exist. Relative remote paths resolve against the persistent remote shell's current directory. Download writes use Pi's file mutation queue.

## Sudo passwords

The `sudo` action first runs `sudo -n true`. In prompt mode, an expired remote sudo timestamp opens a masked prompt in the normal chat-input area. Pi sends the entered password separately over the existing SSH stdin to `sudo -S -p '' -v`, clears its temporary buffer, and relies on the renewed remote timestamp for later calls.

A connection request can set `cacheSudoPassword: true`. If the user chooses YOLO, Pi opens the same masked chat-input prompt after SSH connects and validates the password immediately before `connect` returns. If the user chooses prompt mode, the flag is ignored. Canceling the password prompt or failing validation closes the connection. The password is retained only in a best-effort-zeroed memory buffer for that connection. If the remote sudo timestamp later expires, Pi reauthenticates from that buffer without opening another prompt. Without a cached password, unattended YOLO sudo fails instead of pausing for input.

The retained buffer is cleared on disconnect, connection replacement, timeout, abort, stream loss, or Pi shutdown. The password is not a tool parameter and is not placed in the command, tool result, result details, session entries, temporary files, settings, or SSH/sudo arguments. It is never persisted and is not used for SSH login or key-passphrase authentication.

## Limitations

- One remote host per Pi session.
- No PTY and no interactive remote programs or TUI applications.
- No SSH password, key-passphrase, or keyboard-interactive authentication.
- No support for remote sudo policies that require a TTY (`requiretty`).
- No recursive transfer, directory synchronization, resume, compression, or progress reporting.
- Remote commands require `bash`; file transfers require a compatible `base64` command.

## Development

```bash
pnpm --dir packages/pi-ssh-session test
pnpm --dir packages/pi-ssh-session typecheck
pnpm --dir packages/pi-ssh-session build
```

## License

MIT
