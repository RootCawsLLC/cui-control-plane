import { NextResponse } from 'next/server';
import { runCcp, type RunRequest } from '@/lib/ccp-runner';

// The run spawns a Node child that imports the tool and emits the OSCAL package,
// so this needs the Node runtime and a generous budget.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: RunRequest;
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    body = {};
  }

  try {
    const result = await runCcp(body ?? {});
    return NextResponse.json(result);
  } catch (err) {
    console.error('[run] failed:', err);
    const message = err instanceof Error ? err.message : 'Run failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
