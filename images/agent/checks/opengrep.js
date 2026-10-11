// Примеры для проверки правил фабрики: opengrep scan --test checks/
import { exec, execFile } from "node:child_process";
import https from "node:https";

const input = process.argv[2];

// ruleid: factory.js.eval-dynamic
eval(input);
// ok: factory.js.eval-dynamic
eval("1 + 1");

// ruleid: factory.js.function-constructor
const f = new Function("a", input);

// ruleid: factory.js.shell-command-from-string
exec(`ls ${input}`);
// ruleid: factory.js.shell-command-from-string
exec("cat " + input);
// ok: factory.js.shell-command-from-string
execFile("ls", [input]);
// ok: factory.js.shell-command-from-string
/a(b)/.exec(input);

// ruleid: factory.js.tls-verification-disabled
https.request({ host: "example.org", rejectUnauthorized: false });
// ruleid: factory.js.tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export { f };
