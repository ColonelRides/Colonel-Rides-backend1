const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../lib/rateLimit");

function fakeReqRes(ip = "1.2.3.4", path = "/login") {
  const req = { ip, baseUrl: "", path, socket: { remoteAddress: ip } };
  const res = {
    _status: 200, _json: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(body) { this._json = body; return this; },
    setHeader(k, v) { this._headers[k] = v; },
  };
  return { req, res };
}

test("allows requests under the limit", () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  let nextCalls = 0;
  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes();
    limiter(req, res, () => { nextCalls++; });
  }
  assert.equal(nextCalls, 3, "all 3 requests within the limit should call next()");
});

test("blocks the request that exceeds the limit, with a 429", () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  let nextCalls = 0;
  let lastRes = null;
  for (let i = 0; i < 4; i++) {
    const { req, res } = fakeReqRes();
    lastRes = res;
    limiter(req, res, () => { nextCalls++; });
  }
  assert.equal(nextCalls, 3, "only the first 3 should pass through");
  assert.equal(lastRes._status, 429, "the 4th request should be blocked with 429");
  assert.ok(lastRes._json.error, "should include an error message");
  assert.ok(lastRes._headers["Retry-After"], "should tell the client when to retry");
});

test("tracks different IPs independently — one IP being blocked doesn't affect another", () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2 });
  let nextCalls = 0;
  for (let i = 0; i < 2; i++) {
    const { req, res } = fakeReqRes("1.1.1.1");
    limiter(req, res, () => { nextCalls++; });
  }
  // A completely different IP should still get its own fresh allowance
  const { req, res } = fakeReqRes("9.9.9.9");
  limiter(req, res, () => { nextCalls++; });
  assert.equal(nextCalls, 3, "a different IP should not be affected by another IP's usage");
  assert.equal(res._status, 200, "the different IP's request should not be blocked");
});

test("tracks different routes independently for the same IP", () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1 });
  let nextCalls = 0;
  const { req: r1, res: res1 } = fakeReqRes("5.5.5.5", "/login");
  limiter(r1, res1, () => { nextCalls++; });
  const { req: r2, res: res2 } = fakeReqRes("5.5.5.5", "/signup");
  limiter(r2, res2, () => { nextCalls++; });
  assert.equal(nextCalls, 2, "hitting the limit on one route should not block a different route");
});

test("resets after the window expires", async () => {
  const limiter = createRateLimiter({ windowMs: 50, max: 1 });
  let nextCalls = 0;
  const { req: r1, res: res1 } = fakeReqRes("7.7.7.7");
  limiter(r1, res1, () => { nextCalls++; });

  const { req: r2, res: res2 } = fakeReqRes("7.7.7.7");
  limiter(r2, res2, () => { nextCalls++; });
  assert.equal(res2._status, 429, "second immediate request should be blocked");

  await new Promise((resolve) => setTimeout(resolve, 60));

  const { req: r3, res: res3 } = fakeReqRes("7.7.7.7");
  limiter(r3, res3, () => { nextCalls++; });
  assert.equal(nextCalls, 2, "request after the window expires should be allowed through");
});
