---
"@pedro_klein/pi-ssh-session": minor
---

Add one `ssh_session` tool for persistent remote commands, masked sudo authentication, and binary-safe single or batched file transfers. Every connection asks the user to choose prompt or connection-scoped YOLO mode. YOLO can optionally retain a sudo password in memory for unattended reauthentication, enters it through the chat-input area, and clears it when the connection ends. Commands wait indefinitely unless an explicit timeout is supplied.
