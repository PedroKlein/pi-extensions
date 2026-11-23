import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode = DELETE; CREATE TABLE holder (value); BEGIN IMMEDIATE");
process.send({ phase: "ready" });
let timer;
process.on("message", (message) => {
  if (message.phase === "start") {
    timer = setTimeout(() => {
      db.exec("COMMIT; BEGIN EXCLUSIVE");
      process.send({ phase: "exclusive" });
    }, message.delay);
  } else if (message.phase === "stop") {
    clearTimeout(timer);
    db.exec("ROLLBACK");
    db.close();
    process.disconnect();
  }
});
