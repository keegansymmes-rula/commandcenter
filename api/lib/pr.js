import { execFile, execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function run(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
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
export function searchMyPrs({ role = "author", state = "open", limit = 30 } = {}) {
  const flag = role === "assignee" ? "--assignee=@me" : "--author=@me";
  const result = run(
    `gh search prs ${flag} --state=${state} --json repository,number,title,state,url,isDraft,updatedAt --limit ${limit}`,
  );
  if (!result) return [];
  try {
    return JSON.parse(result);
  } catch {
    return [];
  }
}

const GH_TIMEOUT_MS = 20_000;

// Unlike run(), a failure here must reach the caller: "gh isn't logged in"
// rendered as an empty review queue would read as "nothing to review".
// Async, because the dashboard polls this every minute and a slow search must
// not stall the API's other routes (session updates, dispatch) for its duration.
function runStrict(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || "").trim();
        reject(new Error(`gh search failed: ${detail || "unknown error"}`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

// Open PRs where GitHub is asking *you* for review, across every repo.
// `user-review-requested:@me` matches only a request addressed to your own
// account. `review-requested:@me` (and `gh search prs --review-requested=@me`,
// which sends it) also matches a request made to a team you belong to — a
// whole-team ping nobody personally owes a review on. GitHub silently ignores
// a qualifier it doesn't know, so a typo here would return unrelated PRs
// rather than fail; tests/pr.test.js pins the exact qualifier.
//
// Sorted by GitHub, not afterwards: the default is best-match, so with more
// than `limit` requests the cut would drop the newest ones and re-sorting the
// survivors couldn't bring them back.
export async function searchReviewRequestedPrs({ state = "open", limit = 50 } = {}) {
  const result = await runStrict([
    "search",
    "prs",
    "user-review-requested:@me",
    `--state=${state}`,
    "--sort=updated",
    "--order=desc",
    "--json",
    "repository,number,title,url,isDraft,updatedAt,author",
    `--limit=${limit}`,
  ]);
  return result ? JSON.parse(result) : [];
}

// Same card fields as /api/prs, plus the author (the roles chips don't apply:
// every row here is a review request). Order is whatever GitHub returned.
export function shapeReviewRequests(rawPrs) {
  return rawPrs.map((pr) => ({
    repo: pr.repository?.nameWithOwner || null,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: Boolean(pr.isDraft),
    updatedAt: pr.updatedAt,
    author: pr.author?.login || null,
  }));
}

export async function listReviewRequests() {
  return shapeReviewRequests(await searchReviewRequestedPrs());
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
