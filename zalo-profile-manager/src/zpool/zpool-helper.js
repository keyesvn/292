"use strict";

const PIPE_MARKERS = [
  "PipeZCallSend",
  "PipeZCallRecv",
  "PipeZCallSend3",
  "PipeZCallRecv3",
];

function isCallHelper(command) {
  const value = String(command || "").toLowerCase();
  return value.includes("zalocall") || value.includes("zavimeet");
}

function isCaptureHelper(command) {
  return String(command || "").toLowerCase().includes("zalocap");
}

function isolatePipe(value, suffix) {
  return typeof value === "string" && PIPE_MARKERS.some((marker) => value.includes(marker))
    ? `${value}${suffix}`
    : value;
}

function isolateCallArguments(command, args, suffix) {
  if (!isCallHelper(command) || !Array.isArray(args)) return args;
  return args.map((value) => isolatePipe(value, suffix));
}

module.exports = {
  PIPE_MARKERS,
  isCallHelper,
  isCaptureHelper,
  isolateCallArguments,
  isolatePipe,
};
