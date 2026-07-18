/**
 * Minimal GitHub REST helpers over plain fetch — no SDK dependency.
 * Also owns repo-URL parsing, which tolerates non-GitHub URLs (file://
 * remotes are used in local DRY_RUN testing: no issue fetch, no fork logic).
 */
import { config } from "./config.js";

const API = "https://api.github.com";

/** Parses a task repoUrl into { isGitHub, owner, repo, cloneUrl }. */
export function parseRepoUrl(repoUrl) {
  const url = (repoUrl || "").trim();

  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { isGitHub: true, owner: ssh[1], repo: ssh[2], cloneUrl: url };

  const https = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { isGitHub: true, owner: https[1], repo: https[2], cloneUrl: url };

  // file:// or any non-GitHub remote — clone/push directly, skip GitHub API.
  return { isGitHub: false, owner: null, repo: null, cloneUrl: url };
}

/** Clone URL with the token embedded, so `git clone`/`git push` authenticate. */
export function authenticatedCloneUrl(parsed) {
  if (!parsed.isGitHub || !config.githubToken) return parsed.cloneUrl;
  return `https://x-access-token:${config.githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
}

async function ghFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = data.errors ? ` — ${JSON.stringify(data.errors)}` : "";
    throw new Error(`GitHub API ${res.status} ${method} ${path}: ${data.message || "request failed"}${details}`);
  }
  return data;
}

/** Fetch an issue's { title, body }; returns null on any failure (best-effort). */
export async function getIssue(owner, repo, number) {
  try {
    const issue = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
    return { number, title: issue.title || "", body: issue.body || "" };
  } catch {
    return null;
  }
}

/** Default branch of a repo; falls back to "main". */
export async function getDefaultBranch(owner, repo) {
  try {
    const data = await ghFetch(`/repos/${owner}/${repo}`);
    return data.default_branch || "main";
  } catch {
    return "main";
  }
}

/**
 * Fork the repo into the machine user's account (used when a direct push to
 * origin is rejected). Fork creation is async — poll until it exists.
 */
export async function createFork(owner, repo) {
  const fork = await ghFetch(`/repos/${owner}/${repo}/forks`, { method: "POST" });
  const forkOwner = fork.owner?.login || config.githubUsername;
  const forkRepo = fork.name || repo;
  for (let i = 0; i < 10; i++) {
    try {
      await ghFetch(`/repos/${forkOwner}/${forkRepo}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { owner: forkOwner, repo: forkRepo };
}

/** Open a pull request; head may be "branch" or "forkOwner:branch". */
export async function createPullRequest(owner, repo, { title, head, base, body }) {
  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: { title, head, base, body },
  });
  return { number: pr.number, url: pr.html_url };
}
