import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "..", "dist");

mkdirSync(output, { recursive: true });
cpSync(join(root, "..", "index.html"), join(output, "index.html"));
cpSync(join(root, "..", "admin.html"), join(output, "admin.html"));
cpSync(join(root, "..", "wwwroot", "images"), join(output, "images"), { recursive: true });
writeFileSync(
  join(output, "_routes.json"),
  JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }, null, 2) + "\n"
);
