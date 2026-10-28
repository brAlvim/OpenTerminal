// day-trader-skill — six standard-library Python tools vendored from
// github.com/Jakeschincariol/day-trader-skill (MIT, see server/vendor/day-trader-skill).
// Each run gets its own scratch folder as its working directory, because the
// tools read and write a relative `trader/` folder (plan.json, config.json,
// orders.json, state/). Nothing is shared between runs and the folder is
// removed afterwards, so one request can never see another's plan.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Same depth from src/providers and dist/providers, so dev and build agree.
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "day-trader-skill");
const PYTHON = process.env.PYTHON_BIN ?? "python3";

export type Script = "timemachine.py" | "size.py" | "check.py" | "scan.py" | "facts.py" | "ptr.py";

/** The tool ran and said no, in its own plain words (a refusal, not an outage). */
export class SkillRefusal extends Error {}
/** Python 3.8+ (or pdftotext, for one tool) is missing on this machine. */
export class SkillUnavailable extends Error {}

type Exec = { code: number; stdout: string; stderr: string };

function exec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<Exec> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new SkillUnavailable(`${cmd} not found: install Python 3.8+ (or set PYTHON_BIN) to use the trader tools.`));
        }
        if (err && (err as { killed?: boolean }).killed) {
          return reject(new Error(`${args[1] ?? cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }
        const code = typeof (err as { code?: unknown } | null)?.code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

let pythonCheck: Promise<void> | null = null;
function ensurePython(): Promise<void> {
  pythonCheck ??= exec(PYTHON, ["-c", "import sys; assert sys.version_info >= (3, 8)"], tmpdir(), 10_000).then(
    (r) => {
      if (r.code !== 0) throw new SkillUnavailable(`${PYTHON} is older than 3.8: the trader tools need Python 3.8+.`);
    }
  );
  // Don't remember a failure forever: the user may install Python without restarting.
  pythonCheck.catch(() => (pythonCheck = null));
  return pythonCheck;
}

let pdftotext: Promise<boolean> | null = null;
/** trader-pelosi reads PTR PDFs only through poppler's pdftotext. */
export function hasPdftotext(): Promise<boolean> {
  pdftotext ??= exec("pdftotext", ["-v"], tmpdir(), 10_000).then(
    () => true,
    () => false
  );
  return pdftotext;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export type RunOptions = {
  /** Exit codes that still carry a JSON answer (scan/risk use 1 for "nothing found" / BLOCK). */
  okCodes?: number[];
  timeoutMs?: number;
};

type Run = <T>(script: Script, args: string[], opts?: RunOptions) => Promise<T>;

/**
 * Gives `fn` a fresh scratch folder holding `files` under `trader/`, and a
 * `run` that executes a vendored tool there (with `--json` already in `args`)
 * and returns its parsed stdout. Several tools can share one folder this way,
 * e.g. size.py writes trader/orders.json and check.py reads it. Arguments go
 * straight to execFile (no shell), so a value can never be read as a command;
 * callers still validate them for a clear 400.
 */
export async function inWorkdir<R>(files: Record<string, unknown>, fn: (run: Run) => Promise<R>): Promise<R> {
  await ensurePython();
  const cwd = await mkdtemp(join(tmpdir(), "openterminal-trader-"));
  try {
    await mkdir(join(cwd, "trader"), { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      await writeFile(join(cwd, "trader", name), JSON.stringify(value, null, 2));
    }
    const run: Run = async <T>(script: Script, args: string[], opts: RunOptions = {}) => {
      const r = await exec(PYTHON, ["-I", join(VENDOR_DIR, script), ...args], cwd, opts.timeoutMs ?? 60_000);
      const ok = r.code === 0 || (opts.okCodes ?? []).includes(r.code);
      let parsed: T | undefined;
      try {
        parsed = JSON.parse(r.stdout) as T;
      } catch {
        parsed = undefined;
      }
      if (!ok || parsed === undefined) {
        // The tools refuse in one plain line (wrong date, stop above entry, no
        // SEC User-Agent...). That line is the useful error, not a stack trace.
        throw new SkillRefusal(lastLine(r.stderr) || lastLine(r.stdout) || `${script} exited with code ${r.code}`);
      }
      return parsed;
    };
    return await fn(run);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function runSkill<T>(script: Script, args: string[], opts?: RunOptions): Promise<T> {
  return inWorkdir({}, (run) => run<T>(script, args, opts));
}
