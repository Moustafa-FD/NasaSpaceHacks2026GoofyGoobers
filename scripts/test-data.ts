import { spawn } from "node:child_process";
import { dataPythonExecutable } from "../apps/api/src/environment/service.ts";

const child = spawn(dataPythonExecutable(), ["-m", "unittest", "discover", "-s", "services/data/tests", "-v"], { shell: false, windowsHide: true, stdio: "inherit" });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("close", code => { process.exitCode = code ?? 1; });
