"use strict";

const { hashPassword } = require("../src/security");
const password = process.argv[2];
if (!password) {
  console.error("Cách dùng: node scripts/hash-password.js \"mat-khau-dai-toi-thieu-12-ky-tu\"");
  process.exit(1);
}
console.log(hashPassword(password));
