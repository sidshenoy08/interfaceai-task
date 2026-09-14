import "dotenv/config";
import { runDiscovery } from "./agent/discover.js";
import { replayArtifact } from "./replay/executor.js";
import { runStabilityCheck, decideApproval } from "./replay/stability.js";
import { loadArtifact, saveArtifact } from "./artifact/store.js";

function parseArgs(argv: string[]): { flags: Record<string, string | true>; inputs: Record<string, string> } {
  const flags: Record<string, string | true> = {};
  const inputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "input") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`--input must be name=value, got "${pair}"`);
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, inputs };
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const { flags, inputs } = parseArgs(rest);

  const targetPort = process.env.TARGET_APP_PORT ?? "4000";
  const operatorPort = Number(process.env.OPERATOR_PORT ?? "4001");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o";
  const apiKey = process.env.OPENAI_API_KEY;
  const headed = (process.env.HEADED ?? "true") !== "false";

  if (command === "discover") {
    const goal = String(flags.goal ?? "");
    if (!goal) throw new Error("usage: discover --goal \"...\" [--base-url http://localhost:4000/members]");
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
    const baseUrl = String(flags["base-url"] ?? `http://localhost:${targetPort}/members`);
    const allowedOrigins = [`http://localhost:${targetPort}`];

    console.log(`\nStarting discovery run.\n  goal: ${goal}\n  baseUrl: ${baseUrl}\n  model: ${model}\n`);
    const result = await runDiscovery({ goal, baseUrl, allowedOrigins, model, apiKey, headed, operatorPort });
    console.log(`\nDiscovery finished.`);
    console.log(`  success: ${result.success}`);
    console.log(`  summary: ${result.summary}`);
    console.log(`  evidence: ${result.evidenceDir}`);
    if (result.artifactPath) console.log(`  artifact: ${result.artifactPath}`);
    process.exit(result.success ? 0 : 1);
  }

  if (command === "replay") {
    const artifactRef = String(flags.artifact ?? "");
    if (!artifactRef) throw new Error('usage: replay --artifact <path-or-capability-id> --input name=value [...]');
    const artifact = await loadArtifact(artifactRef);

    console.log(`\nReplaying capability "${artifact.id}" v${artifact.version} (status=${artifact.status}, risk=${artifact.riskLevel}).`);
    console.log(`  inputs: ${JSON.stringify(inputs)}`);

    const inject = flags["inject"];
    const result = await replayArtifact(artifact, inputs, {
      headed,
      operatorPort,
      injectFaultQueryParam: typeof inject === "string" ? `simulate=${inject}` : undefined,
      confirmIrreversible: Boolean(flags["confirm-irreversible"]),
    });

    console.log(`\nReplay finished: ${result.status}`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "success" || result.status === "business_outcome" ? 0 : 1);
  }

  if (command === "stability") {
    const artifactRef = String(flags.artifact ?? "");
    if (!artifactRef) throw new Error('usage: stability --artifact <path-or-capability-id> --runs N --input name=value [...]');
    const runs = Number(flags.runs ?? 3);
    const artifact = await loadArtifact(artifactRef);

    console.log(`\nRunning stability check: capability "${artifact.id}" v${artifact.version}, ${runs} runs, inputs=${JSON.stringify(inputs)}.`);
    const report = await runStabilityCheck(artifact, inputs, runs, { headed, operatorPort });

    console.log(`\nStability report: ${report.successes}/${report.runs} runs behaved correctly (score=${report.score.toFixed(2)}).`);
    for (const r of report.results) console.log(`  ${r.runId}: ${r.status} — ${r.detail}`);
    console.log(`  evidence: ${report.evidenceDir}`);

    const decision = decideApproval(artifact, report);
    const updated = {
      ...artifact,
      status: decision.status,
      confidence: {
        score: report.score,
        runs: report.runs,
        successes: report.successes,
        evaluatedAt: new Date().toISOString(),
        evaluatedWithInputs: inputs,
        evidenceDir: report.evidenceDir,
      },
    };
    const artifactPath = await saveArtifact(updated);

    console.log(`\nApproval decision: ${artifact.status} -> ${decision.status}`);
    console.log(`  reason: ${decision.reason}`);
    console.log(`  artifact updated: ${artifactPath}`);
    process.exit(decision.status === "approved" ? 0 : 1);
  }

  console.log(`Unknown or missing command. Usage:
  npm run discover -- --goal "..." [--base-url ...]
  npm run replay -- --artifact <path-or-id> --input name=value [--input name2=value2] [--inject interstitial|outage] [--confirm-irreversible]
  npm run stability -- --artifact <path-or-id> --runs 3 --input name=value [--input name2=value2]`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
