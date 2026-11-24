import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPrUrl,
  listReviewRequests,
  searchReviewRequestedPrs,
  shapeReviewRequests,
} from "../api/lib/pr.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn() };
});

describe("isPrUrl", () => {
  it("accepts a GitHub PR URL", () => {
    expect(isPrUrl("https://github.com/pathccm/partner-service/pull/123")).toBe(true);
  });

  it("rejects non-PR GitHub URLs", () => {
    expect(isPrUrl("https://github.com/pathccm/partner-service/issues/123")).toBe(false);
    expect(isPrUrl("https://github.com/pathccm/partner-service")).toBe(false);
  });

  it("rejects anything that could break out of the shell quoting", () => {
    expect(isPrUrl("https://github.com/a/b/pull/1'; rm -rf ~; '")).toBe(false);
    expect(isPrUrl("https://github.com/a/b/pull/1 --repo x")).toBe(false);
    expect(isPrUrl("https://github.com/a/b/pull/1\nwhoami")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isPrUrl(undefined)).toBe(false);
    expect(isPrUrl({ url: "https://github.com/a/b/pull/1" })).toBe(false);
  });
});

// execFile's real signature: (file, args, options, callback(err, stdout, stderr)).
function ghReturns(stdout) {
  execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, stdout, ""));
}
function ghFails(message, stderr) {
  execFile.mockImplementation((_file, _args, _opts, cb) =>
    cb(Object.assign(new Error(message), { code: 4 }), "", stderr),
  );
}

describe("searchReviewRequestedPrs", () => {
  // Braces matter: Vitest runs a function returned from beforeEach as teardown.
  beforeEach(() => {
    execFile.mockReset();
  });

  it("asks GitHub for requests addressed to you, not to a team you are on", async () => {
    ghReturns("[]");
    await searchReviewRequestedPrs();
    const [bin, args] = execFile.mock.calls[0];
    expect(bin).toBe("gh");
    expect(args).toContain("user-review-requested:@me");
    // review-requested:@me would also match team requests; GitHub ignores an
    // unknown qualifier instead of erroring, so a slip here fails silently.
    expect(args.join(" ")).not.toMatch(/(^|[^-])review-requested/);
    expect(args).toContain("--state=open");
  });

  it("has GitHub sort newest-updated first, so the limit cuts the oldest", async () => {
    ghReturns("[]");
    await searchReviewRequestedPrs();
    const args = execFile.mock.calls[0][1];
    expect(args).toContain("--sort=updated");
    expect(args).toContain("--order=desc");
  });

  it("bounds the call with a timeout", async () => {
    ghReturns("[]");
    await searchReviewRequestedPrs();
    expect(execFile.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it("returns the parsed list", async () => {
    ghReturns('[{"number":7}]');
    await expect(searchReviewRequestedPrs()).resolves.toEqual([{ number: 7 }]);
  });

  it("treats empty output as no requests", async () => {
    ghReturns("");
    await expect(searchReviewRequestedPrs()).resolves.toEqual([]);
  });

  it("surfaces a gh failure instead of reporting an empty queue", async () => {
    ghFails("exit 4", "gh: To use GitHub CLI, run: gh auth login");
    await expect(searchReviewRequestedPrs()).rejects.toThrow(/gh auth login/);
  });

  it("falls back to the error message when gh wrote nothing to stderr", async () => {
    ghFails("spawn gh ENOENT", "");
    await expect(searchReviewRequestedPrs()).rejects.toThrow(/ENOENT/);
  });
});

describe("shapeReviewRequests", () => {
  const raw = (over) => ({
    repository: { nameWithOwner: "org/repo" },
    number: 1,
    title: "A change",
    url: "https://github.com/org/repo/pull/1",
    isDraft: false,
    updatedAt: "2026-11-10T00:00:00Z",
    author: { login: "ada" },
    ...over,
  });

  it("maps the card fields, including the author", () => {
    expect(shapeReviewRequests([raw()])).toEqual([
      {
        repo: "org/repo",
        number: 1,
        title: "A change",
        url: "https://github.com/org/repo/pull/1",
        isDraft: false,
        updatedAt: "2026-11-10T00:00:00Z",
        author: "ada",
      },
    ]);
  });

  it("keeps GitHub's order", () => {
    const input = [raw({ number: 2 }), raw({ number: 1 }), raw({ number: 3 })];
    expect(shapeReviewRequests(input).map((p) => p.number)).toEqual([2, 1, 3]);
  });

  it("tolerates a missing repository or author (deleted account, ghost user)", () => {
    const [pr] = shapeReviewRequests([raw({ repository: undefined, author: null })]);
    expect(pr.repo).toBeNull();
    expect(pr.author).toBeNull();
  });

  it("keeps drafts, flagged", () => {
    expect(shapeReviewRequests([raw({ isDraft: true })])[0].isDraft).toBe(true);
  });
});

describe("listReviewRequests", () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  it("is the search shaped for the /api/review-requests route", async () => {
    ghReturns(
      JSON.stringify([
        { repository: { nameWithOwner: "o/r" }, number: 9, title: "t", url: "u", isDraft: false, updatedAt: "2026-11-01", author: { login: "bo" } },
      ]),
    );
    await expect(listReviewRequests()).resolves.toEqual([
      { repo: "o/r", number: 9, title: "t", url: "u", isDraft: false, updatedAt: "2026-11-01", author: "bo" },
    ]);
  });

  it("rejects when gh fails, for the route to report as ok:false", async () => {
    ghFails("exit 1", "boom");
    await expect(listReviewRequests()).rejects.toThrow(/boom/);
  });
});
