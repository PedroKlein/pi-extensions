---
"@pedro_klein/pi-ssh-session": minor
---

Add one `ssh_session` tool for persistent named remote shells, masked sudo authentication, and binary-safe single or batched file transfers. Multiple connections can remain alive at once, while calls that omit a connection name use the backward-compatible default shell. Every connection asks the user to choose prompt or connection-scoped YOLO mode. YOLO can optionally retain a sudo password in memory for unattended reauthentication, enters it through the chat-input area, and clears it when the connection ends. Commands stream their combined output while running and wait indefinitely unless an explicit timeout is supplied.
