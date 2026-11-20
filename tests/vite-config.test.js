import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

// The dev proxy's connection behavior is what keeps the dashboard responsive on
// a Mac that never reaps TIME_WAIT (see the comment in vite.config.js), so pin it.
describe("vite dev proxy", () => {
  const proxy = config.server.proxy["/api"];

  it("reuses connections to the API instead of opening one per request", () => {
    expect(proxy.agent.options.keepAlive).toBe(true);
  });

  it("targets the API over IPv4 loopback, not the polluted ::1 pool", () => {
    expect(proxy.target).toBe("http://127.0.0.1:3789");
  });

  it("listens on IPv4 loopback so browsers don't hit ::1:5173", () => {
    expect(config.server.host).toBe("127.0.0.1");
  });
});
