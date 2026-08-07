"use strict";

const { app } = require("electron");
const { resolveZaloInstall } = require("../../src/native-core");

app.whenReady().then(() => {
  try {
    const result = resolveZaloInstall(process.argv[2], undefined, "win32", undefined, process.argv[3]);
    process.stdout.write(`${JSON.stringify({ bundled: result.bundled, version: result.version })}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  }
});
