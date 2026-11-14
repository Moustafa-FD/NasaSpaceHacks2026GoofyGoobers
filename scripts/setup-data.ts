import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPOSITORY_ROOT } from "../apps/api/src/environment/store.ts";

async function run(executable: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: REPOSITORY_ROOT, shell: false, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`Data setup exited with code ${code}`)));
  });
}
await run(process.env.PYTHON_EXECUTABLE ?? "python", ["-m", "venv", ".venv"]);
await run(join(REPOSITORY_ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), ["-m", "pip", "install", "--disable-pip-version-check", "-r", "services/data/requirements.txt"]);
