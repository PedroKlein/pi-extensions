import { MemoryStore } from "../../src/store.ts";
import { resolveStorage } from "../../src/db-path-resolver.ts";

let store;
const send = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => error ? reject(error) : resolve());
});

// Serial IPC phases: parent waits for every worker before releasing each barrier.
process.on("message", async (message) => {
  try {
    if (message.phase === "write") {
      const { options, id, writes } = message;
      const storage = resolveStorage({ ...options, cwd: process.cwd() });
      store = new MemoryStore(storage.dbPath);
      for (let n = 0; n < writes; n++) {
        store.setSemantic(`test.worker-${id}.${n}`, `worker ${id} value ${n}`);
        store.setSemantic("test.shared", `worker ${id} update ${n}`);
      }
      await send({ phase: "written", storage, pid: process.pid });
    } else if (message.phase === "delete") {
      for (let n = 0; n < message.writes; n++) {
        if (!store.deleteSemantic(`test.worker-${message.id}.${n}`)) throw new Error("Missing own key");
      }
      store.close();
      store = undefined;
      await send({ phase: "deleted" });
      process.disconnect();
    } else {
      throw new Error("Unexpected phase");
    }
  } catch (error) {
    try { store?.close(); } finally {
      await send({ phase: "failure", error: String(error?.stack ?? error) });
      process.exitCode = 1;
      process.disconnect();
    }
  }
});
await send({ phase: "ready" });
