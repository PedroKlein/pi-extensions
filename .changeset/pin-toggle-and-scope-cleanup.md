---
"@pedro_klein/pi-adhd": patch
---

Make `p` / `P` a toggle so a pinned note can be unpinned, and clear the previous scope when a note moves between project and global pinning. Pinning was previously a one-way door, and re-pinning left the same note in both `~/.pi/adhd/<repo>.json` and `global.json` — which only looked correct because `loadPinned()` dedupes by id. Both call sites now share one tested `applyPin()` helper, the notes list shows the scope it is pinned to (`📌` project, `🌐` global), and the hint row offers the matching unpin key for the selected note.
