---
"@pedro_klein/pi-memory": patch
---

Treat project slugs literally in scoped memory queries, escaping SQL LIKE metacharacters so underscores cannot match other projects. Match pinned memories against the complete project prefix so repository names containing dots are injected consistently with memory tools.
