import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPrUrl,
  listReviewRequests,
  searchReviewRequestedPrs,
  shapeReviewRequests,
} from "../api/lib/pr.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn() };
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

describe("searchReviewRequestedPrs", () => {
  // Braces matter: Vitest runs a function returned from beforeEach as teardown.
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("asks GitHub for requests addressed to you, not to a team you are on", () => {
    execFileSync.mockReturnValue("[]");
    searchReviewRequestedPrs();
    const [bin, args] = execFileSync.mock.calls[0];
    expect(bin).toBe("gh");
    expect(args).toContain("user-review-requested:@me");
    // review-requested:@me would also match team requests; GitHub ignores an
    // unknown qualifier instead of erroring, so a slip here fails silently.
    expect(args.join(" ")).not.toMatch(/(^|[^-])review-requested/);
    expect(args).toContain("--state=open");
  });

  it("bounds the call with a timeout", () => {
    execFileSync.mockReturnValue("[]");
    searchReviewRequestedPrs();
    expect(execFileSync.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it("returns the parsed list", () => {
    execFileSync.mockReturnValue('[{"number":7}]');
    expect(searchReviewRequestedPrs()).toEqual([{ number: 7 }]);
  });

  it("treats empty output as no requests", () => {
    execFileSync.mockReturnValue("");
    expect(searchReviewRequestedPrs()).toEqual([]);
  });

  it("surfaces a gh failure instead of reporting an empty queue", () => {
    execFileSync.mockImplementation(() => {
      const err = new Error("exit 4");
      err.stderr = "gh: To use GitHub CLI, run: gh auth login";
      throw err;
    });
    expect(() => searchReviewRequestedPrs()).toThrow(/gh auth login/);
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

  it("lists the most recently updated first without mutating the input", () => {
    const input = [
      raw({ number: 1, updatedAt: "2026-11-01T00:00:00Z" }),
      raw({ number: 2, updatedAt: "2026-11-12T00:00:00Z" }),
      raw({ number: 3, updatedAt: "2026-11-05T00:00:00Z" }),
    ];
    expect(shapeReviewRequests(input).map((p) => p.number)).toEqual([2, 3, 1]);
    expect(input.map((p) => p.number)).toEqual([1, 2, 3]);
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
  it("is the search shaped for the /api/review-requests route", () => {
    execFileSync.mockReset();
    execFileSync.mockReturnValue(
      JSON.stringify([
        { repository: { nameWithOwner: "o/r" }, number: 9, title: "t", url: "u", isDraft: false, updatedAt: "2026-11-01", author: { login: "bo" } },
      ]),
    );
    expect(listReviewRequests()).toEqual([
      { repo: "o/r", number: 9, title: "t", url: "u", isDraft: false, updatedAt: "2026-11-01", author: "bo" },
    ]);
  });
});
