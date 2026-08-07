"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const {
  isCaptureHelper,
  isolateCallArguments,
  isolatePipe,
} = require("./zpool-helper");

const instanceSuffix = `${Date.now()}${process.pid}`;
const originalCreateServer = net.createServer;

net.createServer = function createIsolatedServer(...createArgs) {
  const server = originalCreateServer.apply(net, createArgs);
  const originalListen = server.listen;
  server.listen = function listenWithIsolatedPipe(...listenArgs) {
    return originalListen.apply(server, listenArgs.map((value) => isolatePipe(value, instanceSuffix)));
  };
  return server;
};

const argument = process.argv.find((value) => /^--appdata-id=[1-9]\d{0,8}$/.test(value));
if (argument) {
  const appDataId = argument.slice(argument.indexOf("=") + 1);
  global.appDataId = appDataId;
  global.isCloneApp = 1;
  app.setPath("userData", path.join(app.getPath("appData"), `ZaloData_${appDataId}`));
}

const pcNameArgument = process.argv.find((value) => value.startsWith("--pc-name="));
if (pcNameArgument) {
  const pcName = Buffer.from(pcNameArgument.slice("--pc-name=".length), "base64").toString("utf8");
  if (pcName) {
    global.pcName = pcName;
    process.env.ZPOOL_PC_NAME = pcName;
    os.hostname = () => pcName;
  }
}

if (!process.argv.includes("--restore-session")) {
  const originalSpawn = childProcess.spawn;
  const captureLock = process.platform === "win32"
    ? path.join(path.dirname(app.getPath("exe")), "plugins", "capture", "capture.lock")
    : path.join(path.dirname(app.getPath("exe")), "..", "ZaloCapture.app", "Contents", "MacOS", "capture.lock");
  let captureHeartbeat = null;
  let ownedCapturePid = null;

  function readCurrentCaptureLock() {
    try {
      const lock = JSON.parse(fs.readFileSync(captureLock, "utf8"));
      if (lock?.id && lock?.time && Date.now() - Number(lock.time) <= 10000) return lock;
    } catch {}
    try { fs.unlinkSync(captureLock); } catch {}
    return null;
  }

  function stopCaptureHeartbeat(pid) {
    if (Number(pid) !== ownedCapturePid) return;
    if (captureHeartbeat) clearInterval(captureHeartbeat);
    captureHeartbeat = null;
    try {
      const lock = JSON.parse(fs.readFileSync(captureLock, "utf8"));
      if (Number(lock?.id) === ownedCapturePid) fs.unlinkSync(captureLock);
    } catch {}
    ownedCapturePid = null;
  }

  childProcess.spawn = function spawnWithProfileHelpers(command, args, options) {
    let executable = command;
    const isolatedArgs = isolateCallArguments(command, args, instanceSuffix);
    const capture = isCaptureHelper(command);
    const currentLock = capture ? readCurrentCaptureLock() : null;
    if (capture && currentLock) executable = "./zalocap";

    const child = originalSpawn(executable, isolatedArgs, options);
    if (capture && !currentLock && child?.pid) {
      ownedCapturePid = child.pid;
      const writeLock = () => {
        try {
          fs.mkdirSync(path.dirname(captureLock), { recursive: true });
          fs.writeFileSync(captureLock, JSON.stringify({ id: child.pid, time: Date.now() }), "utf8");
        } catch {}
      };
      writeLock();
      captureHeartbeat = setInterval(writeLock, 5000);
    }
    if (capture && child?.once) child.once("exit", () => stopCaptureHeartbeat(child.pid));
    return child;
  };

  app.on("before-quit", () => stopCaptureHeartbeat(ownedCapturePid));
}
