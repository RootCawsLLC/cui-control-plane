/**
 * Server-only bridge to the real cui-control-plane tool.
 *
 * It does NOT reimplement or import the tool into the Next bundle. It spawns a
 * plain Node ESM process (scripts/run-ccp.mjs) that imports the tool's modules
 * natively and runs the exact shipped code path (coverage / sprs / variance /
 * emit all), then relays that process's JSON result. Running out-of-process keeps
 * the tool's ESM resolution and filesystem behavior identical to the CLI and
 * avoids the ESM/CJS interop that breaks when a pure-ESM tool is pulled into the
 * Next bundle under `next start`.
 */
import 'server-only';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface RunRequest {
  sections?: {
    coverage?: boolean;
    sprs?: boolean;
    variance?: boolean;
    oscal?: boolean;
  };
}

function scriptPath(): string {
  return process.env.CCP_SCRIPT ?? join(process.cwd(), 'scripts', 'run-ccp.mjs');
}

const HARD_TIMEOUT_MS = 120_000;

export async function runCcp(req: RunRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath()], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Run timed out.'));
    }, HARD_TIMEOUT_MS);

    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(killer);
      let parsed: (Record<string, unknown> & { error?: string }) | null = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        reject(new Error(`Run process produced no valid result.${err ? ` (${err.slice(0, 400)})` : ''}`));
        return;
      }
      if (parsed && parsed.error) {
        reject(new Error(String(parsed.error).split('\n')[0]));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });

    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}
