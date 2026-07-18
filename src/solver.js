/**
 * Pluggable solver drivers. A driver implements:
 *
 *   solve({ repoDir, task, issue }) → Promise<{ summary: string }>
 *
 *   repoDir — absolute path of the cloned working copy (on the task branch)
 *   task    — the on-chain task struct (repoUrl, issueId, rewardAmount, ...)
 *   issue   — { number?, title, body } — best-effort GitHub issue content,
 *             or a fallback built from the raw on-chain issueId string
 *
 * The driver mutates the working copy; the job pipeline commits whatever
 * changed. `summary` becomes the top of the PR body.
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

/**
 * "echo" driver — no AI. Writes SOLUTION.md documenting the task so the whole
 * pipeline (clone → commit → push → PR/markers) can be exercised end-to-end.
 * For pipeline testing only; it never actually fixes anything.
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
      `- Generated at: ${new Date().toISOString()}`,
      "",
      "This file was produced by the `echo` solver driver, which exists to test",
      "the autonomous-agent pipeline (clone → solve → commit → push → PR) without",
      "invoking an AI. It does not solve the issue.",
      "",
    ].join("\n");
    await writeFile(path.join(repoDir, "SOLUTION.md"), content, "utf8");
    return { summary: `Echo driver: wrote SOLUTION.md for task ${task.taskId} (pipeline test, no real fix).` };
  },
};

/**
 * "claude-cli" driver — spawns the Claude Code CLI headless inside the repo:
 *
 *   claude -p --permission-mode acceptEdits   (prompt piped via stdin)
 *
 * Requires Claude Code installed AND authenticated on the host machine.
 * The prompt is piped through stdin rather than argv so multi-line issue
 * bodies survive Windows shell quoting.
 */
const claudeCliDriver = {
  name: "claude-cli",
  async solve({ repoDir, task, issue }) {
    const prompt =
      "You are an autonomous coding agent competing for a bounty. " +
      "Fix the following GitHub issue in this repository. " +
      `Make the smallest correct change. Issue: ${issueText(issue)}`;

    const stdout = await new Promise((resolve, reject) => {
      const child = spawn("claude", ["-p", "--permission-mode", "acceptEdits"], {
        cwd: repoDir,
        shell: process.platform === "win32", // resolve claude.cmd shims on Windows
        windowsHide: true,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => reject(new Error(`failed to spawn claude CLI: ${e.message}`)));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 1000) || out.slice(0, 1000)}`));
        resolve(out);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });

    const summary = stdout.trim().slice(0, SUMMARY_MAX) || "Claude CLI produced no summary output.";
    return { summary };
  },
};

// ---------------------------------------------------------------------------
// EXTENSION POINT: add an "anthropic-api" driver here that calls the Anthropic
// Messages API directly (agentic loop with read/edit/bash tools over repoDir)
// instead of shelling out to the Claude Code CLI. Register it in DRIVERS and
// whitelist the name in src/config.js.
// ---------------------------------------------------------------------------

const DRIVERS = {
  echo: echoDriver,
  "claude-cli": claudeCliDriver,
};

export function getSolver(name = config.solver) {
  const driver = DRIVERS[name];
  if (!driver) throw new Error(`Unknown solver driver: ${name}`);
  return driver;
}
