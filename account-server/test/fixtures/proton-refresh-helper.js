"use strict";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const account = JSON.parse(input);
  if (!account.password || account.email !== "proton@example.test") process.exit(2);
  if (process.argv.includes("--diagnostic-prefix")) process.stdout.write("Chromedriver diagnostic line\n");
  process.stdout.write(JSON.stringify({ cookie: `AUTH-${account.uid}=renewed-cookie`, uid: account.uid, appVersion: "web-vpn@renewed" }));
});
