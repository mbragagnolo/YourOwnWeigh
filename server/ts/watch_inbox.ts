/** Imports Garmin FIT files dropped into a folder (YOW_WATCH_INBOX), which the
 * Windows sync script fills from the watch over USB. Files stay in the inbox
 * as the archive: the watch deletes its own copies after a few weeks. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { importWatchFile } from "./watch.ts";

const FIT = /\.fit$/i;

function fitFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // Dot folders (the sync script's .staging) hold files still being copied.
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) found.push(...fitFiles(path));
    else if (entry.isFile() && FIT.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/** One pass over the inbox. Unchanged files are skipped without reading them. */
export async function scanWatchInbox(
  db: D1Database,
  dir: string,
  seen: Map<string, string>,
  now = () => Math.floor(Date.now() / 1000),
) {
  const counts = { imported: 0, duplicate: 0, failed: 0 };
  for (const path of fitFiles(dir)) {
    const stat = statSync(path);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (seen.get(path) === stamp) continue;
    const result = await importWatchFile(db, relative(dir, path), readFileSync(path), now());
    counts[result]++;
    seen.set(path, stamp);
  }
  return counts;
}

/** Scans now and then every `intervalMs`; errors are logged, never fatal. */
export function watchInbox(db: D1Database, dir: string, intervalMs = 60_000) {
  const seen = new Map<string, string>();
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const c = await scanWatchInbox(db, dir, seen);
      if (c.imported || c.failed)
        console.log(`Watch inbox: ${c.imported} imported, ${c.failed} failed`);
    } catch (error) {
      console.error(`Watch inbox: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(pass, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
