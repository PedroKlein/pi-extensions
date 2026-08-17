---
"@pedro_klein/pi-gateway": minor
---

Scrub internal/company-specific names from public docs, examples, and code.

- README, CHANGELOG, and all source doc-comments now use neutral example
  provider names (`openrouter`, `groq`) instead of internal ones.
- **BREAKING (config):** the shipped `quotaHint` enricher is renamed
  `hai-daily-eur` → `daily-eur-cap`. Update `aliases.json` accordingly. The
  enricher's behavior is unchanged (parses a `DAILY_CAP_EXCEEDED` body with
  `cap_eur`/`spent_eur` fields).
- Removed the now-dead `backendFamilySuffix` export (family-pinned aliases
  were dropped in 0.3.0) and its tests.
- Test fixtures use neutral backend/model names.
