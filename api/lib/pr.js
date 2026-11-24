import { execFile, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// An unbounded gh call hung for hours after a network stall and, under
// execSync, froze the whole API (every route queued behind it, so the board
// never left "Loading"). Bound every call; SIGKILL because gh can ignore TERM
// while stuck on a socket.
const GH_TIMEOUT_MS = 30_000;

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }).trim();
  } catch {
    return null;
  }
}

export function checkPrExists(branch, base, cwd) {
  const result = run(
    `gh pr list --head ${branch} --base ${base} --json number,url,state --limit 1`,
    cwd,
  );
  if (!result) return null;
  try {
    const prs = JSON.parse(result);
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

// General-purpose PR-state probe. Hits `gh pr list` with the supplied filters,
// JSON-decodes the first match, and returns a normalized object. Returns null
// when no PR matches (callers should treat that as "nothing to act on").
//
// `state` ∈ "open" | "closed" | "merged" | "all" (gh accepts these).
// `fields` defaults to a reasonable superset; pass an array to override.
export function prState(branch, { base, state = "all", cwd, fields } = {}) {
  if (!branch || !cwd) return null;
  const fieldList = (
    fields || [
      "number",
      "url",
      "state",
      "title",
      "headRefName",
      "baseRefName",
      "mergeCommit",
      "mergedAt",
    ]
  ).join(",");
  const baseFlag = base ? `--base ${base}` : "";
  const stateFlag = state ? `--state ${state}` : "";
  const result = run(
    `gh pr list --head ${branch} ${baseFlag} ${stateFlag} --json ${fieldList} --limit 1`,
    cwd,
  );
  if (!result) return null;
  try {
    const prs = JSON.parse(result);
    if (prs.length === 0) return null;
    const pr = prs[0];
    return {
      number: pr.number ?? null,
      url: pr.url ?? null,
      state: pr.state ?? null,
      title: pr.title ?? null,
      headRefName: pr.headRefName ?? null,
      baseRefName: pr.baseRefName ?? null,
      mergeCommit: pr.mergeCommit?.oid || pr.mergeCommit || null,
      mergedAt: pr.mergedAt ?? null,
    };
  } catch {
    return null;
  }
}

// Cross-repo PR search via `gh search prs` — no cwd needed, this searches
// every repo the authenticated gh user can see, not one local clone.
// `role` is "author" or "assignee"; GitHub treats these as distinct from
// each other and from review-requests, so callers wanting both call this
// twice and merge rather than this trying to guess a combined meaning.
//
// Async (not `run`) because /api/prs polls this: a slow GitHub must not block
// the event loop for every other route.
export async function searchMyPrs({ role = "author", state = "open", limit = 30 } = {}) {
  const flag = role === "assignee" ? "--assignee=@me" : "--author=@me";
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "search",
        "prs",
        flag,
        `--state=${state}`,
        "--json",
        "repository,number,title,state,url,isDraft,updatedAt",
        "--limit",
        String(limit),
      ],
      { encoding: "utf-8", timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    return JSON.parse(stdout.trim());
  } catch {
    return [];
  }
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/;

export function isPrUrl(url) {
  return typeof url === "string" && PR_URL.test(url);
}

// Any PR by URL, not just ones searchMyPrs would find. The URL is
// interpolated into a shell command, so anything that isn't strictly a
// GitHub PR URL is rejected before it gets near execSync. repo comes from
// the URL rather than headRepository, which names the fork on a fork PR.
export function viewPr(url) {
  if (!isPrUrl(url)) return null;
  const result = run(`gh pr view '${url}' --json title,url,number`);
  if (!result) return null;
  try {
    const pr = JSON.parse(result);
    return {
      title: pr.title,
      url: pr.url,
      number: pr.number,
      repo: url.match(PR_URL)[1],
    };
  } catch {
    return null;
  }
}

export function pushBranch(branch, cwd, force = false) {
  const flag = force ? "--force-with-lease" : "-u";
  const result = run(`git push ${flag} origin ${branch}`, cwd);
  return result !== null;
}

export function createPr(branch, base, title, body, draft, cwd) {
  const draftFlag = draft ? "--draft " : "";
  const escaped = body.replace(/'/g, "'\\''");
  const result = run(
    `gh pr create ${draftFlag}--base ${base} --title '${title.replace(/'/g, "'\\''")}' --body '${escaped}'`,
    cwd,
  );
  if (!result) return null;
  const prInfo = run(`gh pr view ${branch} --json number,url,state`, cwd);
  if (!prInfo) return null;
  try {
    return JSON.parse(prInfo);
  } catch {
    return null;
  }
}

export function ensurePr({
  branch,
  base,
  title,
  bodyFile,
  draft = false,
  forcePush = false,
  cwd,
}) {
  const existing = checkPrExists(branch, base, cwd);
  if (existing) {
    const pushed = pushBranch(branch, cwd, forcePush);
    return { action: "exists", pr: existing, pushed };
  }

  const pushed = pushBranch(branch, cwd, forcePush);
  if (!pushed) {
    return { action: "push_failed", pr: null, pushed: false };
  }

  let body = "";
  let prTitle = title || branch;
  if (bodyFile) {
    try {
      const content = readFileSync(bodyFile, "utf-8");
      const lines = content.split("\n");
      prTitle = title || lines[0].replace(/^#\s*/, "").trim();
      body = lines.slice(1).join("\n").trim();
    } catch {
      // bodyFile not found, proceed with empty body
    }
  }

  const pr = createPr(branch, base, prTitle, body, draft, cwd);
  if (!pr) {
    return { action: "create_failed", pr: null, pushed: true };
  }

  return { action: "created", pr, pushed: true };
}
