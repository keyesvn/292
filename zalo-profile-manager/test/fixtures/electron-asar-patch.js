"use strict";

const { app } = require("electron");
const { ensurePatched, inspectArchive } = require("../../src/native-core");

app.whenReady().then(async () => {
  try {
    const result = await ensurePatched(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify({ changed: result.changed, patched: inspectArchive(process.argv[2]).patched })}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  }
});
