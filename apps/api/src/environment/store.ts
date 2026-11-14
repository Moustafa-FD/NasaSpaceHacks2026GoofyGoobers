import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export class EnvironmentStore {
  readonly root: string;
  readonly rawDirectory: string;
  readonly processedDirectory: string;
  readonly runsDirectory: string;
  constructor(root = REPOSITORY_ROOT) {
    this.root = resolve(root);
    this.rawDirectory = join(this.root, "data", "raw", "environment");
    this.processedDirectory = join(this.root, "data", "processed", "environment");
    this.runsDirectory = join(this.root, "data", "runs", "environment");
  }
  async init(): Promise<void> { await Promise.all([this.rawDirectory, this.processedDirectory, this.runsDirectory].map(path => mkdir(path, { recursive: true }))); }
  key(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private file(directory: string, key: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid local cache key");
    return join(directory, `${key}.json`);
  }
  async read<T>(directory: string, key: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.file(directory, key), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async write(directory: string, key: string, value: unknown): Promise<void> {
    await mkdir(directory, { recursive: true });
    const destination = this.file(directory, key);
    const temporary = `${destination}.${randomUUID()}.part`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(temporary, destination);
  }
  async list(directory: string): Promise<string[]> { try { return (await readdir(directory)).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  async bytes(directory = this.rawDirectory): Promise<number> {
    let size = 0;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) size += await this.bytes(path);
      else if (entry.isFile()) size += (await stat(path)).size;
    }
    return size;
  }
}
