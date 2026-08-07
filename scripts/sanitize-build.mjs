import { rmSync } from "node:fs";
import { resolve } from "node:path";

const localSecretsFile = resolve(process.cwd(), "dist", "agentflowing", ".dev.vars");
rmSync(localSecretsFile, { force: true });
