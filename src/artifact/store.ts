import { promises as fs } from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

const ARTIFACTS_DIR = path.resolve(process.cwd(), "artifacts");

function fileFor(id: string, version: number): string {
  return path.join(ARTIFACTS_DIR, `${id}.v${version}.json`);
}

export async function saveArtifact(artifact: CapabilityArtifact): Promise<string> {
  CapabilityArtifactSchema.parse(artifact); // fail loudly on a malformed artifact
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const file = fileFor(artifact.id, artifact.version);
  await fs.writeFile(file, JSON.stringify(artifact, null, 2), "utf8");

  // Maintain a `latest` pointer per capability id for convenience.
  const latestFile = path.join(ARTIFACTS_DIR, `${artifact.id}.latest.json`);
  await fs.writeFile(latestFile, JSON.stringify(artifact, null, 2), "utf8");
  return file;
}

export async function loadArtifact(fileOrId: string): Promise<CapabilityArtifact> {
  let file = fileOrId;
  if (!fileOrId.endsWith(".json")) {
    file = path.join(ARTIFACTS_DIR, `${fileOrId}.latest.json`);
  } else if (!path.isAbsolute(fileOrId)) {
    file = path.join(process.cwd(), fileOrId);
  }
  const raw = await fs.readFile(file, "utf8");
  return CapabilityArtifactSchema.parse(JSON.parse(raw));
}

export async function nextVersion(id: string): Promise<number> {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const files = await fs.readdir(ARTIFACTS_DIR);
  const versions = files
    .map((f) => f.match(new RegExp(`^${id}\\.v(\\d+)\\.json$`)))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
  return versions.length ? Math.max(...versions) + 1 : 1;
}
