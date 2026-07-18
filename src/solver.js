/**
 * Pluggable solver drivers. A driver implements:
 *
 *   solve({ repoDir, task, issue }) → Promise<{ summary: string }>
 *
 * The driver mutates the cloned working copy; the job pipeline commits whatever
 * changed. `summary` becomes the top of the PR body.
 *
 * Drivers that ship here:
 *   - "echo"     — no AI; writes SOLUTION.md to test the pipeline.
 *   - CLI agents — spawn a headless AI coding agent inside the repo, which reads
 *     the issue and edits files on its own. Presets: claude / codex / opencode /
 *     antigravity. Flags are overridable via env, so if a tool changes its CLI
 *     you just tweak SOLVER_ARGS — no code edit.
 *   - "custom"   — write your own driver (see the stub at the bottom).
 *
 * Env overrides for the CLI presets (all optional):
 *   SOLVER_COMMAND     the executable to run (e.g. a custom install path)
 *   SOLVER_ARGS        space-separated args (replaces the preset's args)
 *   SOLVER_PROMPT_VIA  "stdin" (default) or "arg" — how the prompt is passed
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const SUMMARY_MAX = 4000;

function issueText(issue) {
  if (issue.title || issue.body) {
    return [issue.title, issue.body].filter(Boolean).join("\n\n");
  }
  return issue.ref || "unknown issue";
}

function buildPrompt(issue) {
  return (
    "You are an autonomous coding agent competing for a bounty. " +
    "Fix the following GitHub issue in this repository. " +
    `Make the smallest correct change. Issue: ${issueText(issue)}`
  );
}

/**
 * "echo" driver — no AI. Writes SOLUTION.md documenting the task so the whole
 * pipeline can be exercised end-to-end. For testing only; it never fixes anything.
 */
const echoDriver = {
  name: "echo",
  async solve({ repoDir, task, issue }) {
    const content = [
      "# Jumboo echo-driver solution",
      "",
      `- Task ID: ${task.taskId}`,
      `- Repo: ${task.repoUrl}`,
      `- Issue: ${issueText(issue)}`,
      "",
      "Produced by the `echo` solver driver to test the pipeline. It does not",
      "solve the issue — pick a real solver (claude, codex, opencode, …) to compete.",
      "",
    ].join("\n");
    await writeFile(path.join(repoDir, "SOLUTION.md"), content, "utf8");
    return { summary: `Echo driver: wrote SOLUTION.md for task ${task.taskId} (pipeline test, no real fix).` };
  },
};

// Placeholder for where the prompt goes in a preset's args. If present it is
// substituted; otherwise the prompt is appended (promptVia "arg") or piped on
// stdin (promptVia "stdin").
const PROMPT = "{prompt}";

/**
 * Default invocation for each known AI coding-agent CLI. Every preset runs the
 * agent FULLY AUTONOMOUSLY — it skips the tool's permission/approval prompts so
 * it can work unattended. Only run these on a machine you control (a sandbox or
 * VPS). Flags are best-effort defaults — override with SOLVER_ARGS if your
 * version of a tool expects different ones.
 */
export const CLI_PRESETS = {
  claude: { command: "claude", args: ["-p", "--dangerously-skip-permissions"], promptVia: "stdin" },
  codex: { command: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox"], promptVia: "arg" },
  opencode: { command: "opencode", args: ["run", "--auto"], promptVia: "arg" },
  // Antigravity's binary is `agy`; the prompt is the value of -p.
  antigravity: { command: "agy", args: ["-p", PROMPT, "--dangerously-skip-permissions"], promptVia: "arg" },
};

/**
 * Work out the final argv and whether the prompt goes on stdin:
 *   - PROMPT placeholder present → substitute it in place
 *   - promptVia "arg"            → append the prompt as the last argument
 *   - otherwise                  → pipe the prompt on stdin
 */
export function buildInvocation({ args, promptVia, prompt }) {
  const usesPlaceholder = args.includes(PROMPT);
  const finalArgs = usesPlaceholder
    ? args.map((a) => (a === PROMPT ? prompt : a))
    : promptVia === "arg"
      ? [...args, prompt]
      : [...args];
  const viaStdin = !usesPlaceholder && promptVia !== "arg";
  return { finalArgs, viaStdin };
}

/** Spawn a headless CLI agent in the repo and return its stdout as the summary. */
function runCliAgent({ command, args, promptVia, prompt, repoDir }) {
  return new Promise((resolve, reject) => {
    const { finalArgs, viaStdin } = buildInvocation({ args, promptVia, prompt });
    const child = spawn(command, finalArgs, {
      cwd: repoDir,
      shell: process.platform === "win32", // resolve .cmd shims on Windows
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`failed to spawn ${command}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`${command} exited ${code}: ${(err || out).trim().slice(0, 1000)}`));
      }
      resolve(out.trim().slice(0, SUMMARY_MAX) || `${command} produced no summary output.`);
    });
    if (viaStdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/** Build a CLI-agent driver from a preset (with env overrides applied). */
function cliDriver(name, preset) {
  return {
    name,
    async solve({ repoDir, issue }) {
      const command = config.solverCommand || preset.command;
      const args = config.solverArgs ?? preset.args;
      const promptVia = config.solverPromptVia || preset.promptVia;
      const summary = await runCliAgent({ command, args, promptVia, prompt: buildPrompt(issue), repoDir });
      return { summary };
    },
  };
}

/**
 * "custom" driver — WRITE YOUR OWN.
 *
 * Use this when you don't want one of the CLI agents above. Read the issue,
 * make changes inside `repoDir` any way you like (call your own model/service,
 * run a script, apply a patch…), then return a short summary for the PR body.
 * The job pipeline commits whatever files changed.
 */
const customDriver = {
  name: "custom",
  async solve({ repoDir, task, issue }) {
    // ----------------------------------------------------------------------
    // TODO: implement your solving logic here. Example shape:
    //
    //   const prompt = buildPrompt(issue);
    //   ... do the work, edit files under `repoDir` ...
    //   return { summary: "what you changed and why" };
    //
    // `issue` is { title, body, ref }; `task` has { taskId, repoUrl, issueId }.
    // ----------------------------------------------------------------------
    throw new Error("custom solver not implemented — edit solve() in src/solver.js");
  },
};

/** Resolve the configured solver. */
export function getSolver(name = config.solver) {
  if (name === "echo") return echoDriver;
  if (name === "custom") return customDriver;
  const preset = CLI_PRESETS[name];
  if (!preset) {
    const known = ["echo", ...Object.keys(CLI_PRESETS), "custom"].join(", ");
    throw new Error(`Unknown solver "${name}". Use one of: ${known}.`);
  }
  return cliDriver(name, preset);
}
