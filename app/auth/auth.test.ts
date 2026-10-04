// App side of sign-in (plan 10 §10.7; 99 §99.1 app/auth/auth.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubFetch } from "./api.ts";
import { WORKER_ORIGIN } from "./config.ts";
import { accessToken, exchangeReturnCode, readAuth, refreshAuth, signOut, SignedOutError, startSignIn } from "./session.ts";

const HOUR = 3600_000;

interface Call {
  url: string;
  body: Record<string, string>;
}

let calls: Call[];
let events: string[];

function stubFetch(answer: (url: string, body: Record<string, string>) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    calls.push({ url, body });
    events.push(`fetch ${url.replace(WORKER_ORIGIN, "")}`);
    return answer(url, body);
  }));
}

const tokens = (n: number): Response => new Response(JSON.stringify({
  access_token: `ghu_${n}`, expires_in: 28800, refresh_token: `ghr_${n}`, refresh_token_expires_in: 15897600,
}), { status: 200 });

/** navigator.locks: one holder at a time per name, in request order (the Web Locks contract the refresh relies on). */
function installLocks(): void {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, cb: () => Promise<unknown>) => {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(cb, cb);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
}

beforeEach(() => {
  calls = [];
  events = [];
  localStorage.clear();
  installLocks();
  history.replaceState(null, "", "/pa-studying/#/eor/fm");
  window.name = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the return from GitHub", () => {
  it("stops with the failure state, posting nothing, when state differs from pa.oauth", async () => {
    stubFetch(() => tokens(1));
    localStorage.setItem("pa.oauth", JSON.stringify({ state: "expected", verifier: "v" }));
    history.replaceState(null, "", "/pa-studying/?code=c1&state=other#/eor/fm");

    expect(await exchangeReturnCode()).toBe("failed");
    expect(calls).toEqual([]);
    expect(localStorage.getItem("pa.oauth")).toBeNull();
    expect(readAuth()).toBeNull();
    expect(location.search).toBe("");
    expect(location.hash).toBe("#/eor/fm");
  });

  it("exchanges the code with the stored verifier, stores pa.auth with absolute expiries, and clears pa.oauth", async () => {
    stubFetch(() => tokens(1));
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    localStorage.setItem("pa.oauth", JSON.stringify({ state: "s1", verifier: "ver1" }));
    history.replaceState(null, "", "/pa-studying/?code=c1&state=s1#/other");

    expect(await exchangeReturnCode()).toBe("signed-in");
    expect(calls).toEqual([{ url: `${WORKER_ORIGIN}/token`, body: { code: "c1", code_verifier: "ver1" } }]);
    expect(readAuth()).toEqual({ access: "ghu_1", accessExp: 1_000_000 + 28800_000, refresh: "ghr_1", refreshExp: 1_000_000 + 15897600_000 });
    expect(localStorage.getItem("pa.oauth")).toBeNull();
    expect(location.search).toBe("");
  });

  it("fails without storing tokens when the Worker answers 400", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 }));
    localStorage.setItem("pa.oauth", JSON.stringify({ state: "s1", verifier: "ver1" }));
    history.replaceState(null, "", "/pa-studying/?code=c1&state=s1");

    expect(await exchangeReturnCode()).toBe("failed");
    expect(readAuth()).toBeNull();
    expect(localStorage.getItem("pa.oauth")).toBeNull();
  });

  it("does nothing on an ordinary load", async () => {
    stubFetch(() => tokens(1));
    expect(await exchangeReturnCode()).toBe("none");
    expect(calls).toEqual([]);
  });
});

describe("starting sign-in", () => {
  it("stores the attempt and opens the authorize page in the named popup", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const outcome = await startSignIn({ state: "st", verifier: "ve", url: "https://github.com/login/oauth/authorize?x=1" });
    expect(outcome).toBe("popup");
    expect(open).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?x=1", "pa-signin", "popup,width=520,height=720");
    expect(JSON.parse(localStorage.getItem("pa.oauth") ?? "null")).toEqual({ state: "st", verifier: "ve" });
  });
});

describe("refresh", () => {
  it("two tabs refreshing at once spend the refresh token once; the second reads the new pair inside the lock", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "old", accessExp: Date.now() + 60_000, refresh: "r-old", refreshExp: Date.now() + HOUR }));
    stubFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return tokens(2);
    });

    const [a, b] = await Promise.all([refreshAuth("old"), refreshAuth("old")]);
    expect(calls.filter((c) => c.url.endsWith("/refresh"))).toEqual([{ url: `${WORKER_ORIGIN}/refresh`, body: { refresh_token: "r-old" } }]);
    expect(a.access).toBe("ghu_2");
    expect(b.access).toBe("ghu_2");
    expect(readAuth()?.refresh).toBe("ghr_2");
  });

  it("refreshes before a call when the access token has under 5 minutes left", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "old", accessExp: Date.now() + 4 * 60_000, refresh: "r-old", refreshExp: Date.now() + HOUR }));
    stubFetch(() => tokens(3));
    expect(await accessToken()).toBe("ghu_3");
  });

  it("uses the stored token while it has 5 minutes or more left", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "cur", accessExp: Date.now() + 10 * 60_000, refresh: "r", refreshExp: Date.now() + HOUR }));
    stubFetch(() => tokens(3));
    expect(await accessToken()).toBe("cur");
    expect(calls).toEqual([]);
  });

  it("a refused refresh clears pa.auth and reports the sign-in as expired", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "old", accessExp: 0, refresh: "r-old", refreshExp: Date.now() + HOUR }));
    stubFetch(() => new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 400 }));
    await expect(refreshAuth("old")).rejects.toBeInstanceOf(SignedOutError);
    expect(readAuth()).toBeNull();
  });

  it("a lapsed refresh token is not sent", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "old", accessExp: 0, refresh: "r-old", refreshExp: Date.now() - 1 }));
    stubFetch(() => tokens(4));
    await expect(refreshAuth("old")).rejects.toBeInstanceOf(SignedOutError);
    expect(calls).toEqual([]);
    expect(readAuth()).toBeNull();
  });
});

describe("GitHub API calls", () => {
  it("bypass the HTTP cache (GitHub marks ref reads max-age=60), with and after a refresh", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "stale", accessExp: Date.now() + HOUR, refresh: "r", refreshExp: Date.now() + HOUR }));
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(WORKER_ORIGIN)) return tokens(7);
      inits.push(init ?? {});
      return new Response("{}", { status: inits.length === 1 ? 401 : 200 });
    }));
    const res = await githubFetch("/repos/kaitlyla/pa-studying/git/ref/heads/main");
    expect(res.status).toBe(200);
    expect(inits.map((i) => i.cache)).toEqual(["no-store", "no-store"]);
  });
});

describe("sign out", () => {
  function track(): void {
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      events.push(`remove ${key}`);
      remove.call(this, key);
    });
    vi.spyOn(BroadcastChannel.prototype, "postMessage").mockImplementation((m: unknown) => {
      events.push(`broadcast ${(m as { type: string }).type}`);
    });
  }

  it("calls /revoke, then deletes pa.auth, then broadcasts, in that order", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "ghu_9", accessExp: Date.now() + HOUR, refresh: "r", refreshExp: Date.now() + HOUR }));
    stubFetch(() => new Response(null, { status: 204 }));
    track();
    await signOut();
    expect(events).toEqual(["fetch /revoke", "remove pa.auth", "broadcast signed-out"]);
    expect(calls[0]?.body).toEqual({ access_token: "ghu_9" });
    expect(readAuth()).toBeNull();
  });

  it("deletes pa.auth even when /revoke fails", async () => {
    localStorage.setItem("pa.auth", JSON.stringify({ access: "ghu_9", accessExp: Date.now() + HOUR, refresh: "r", refreshExp: Date.now() + HOUR }));
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    track();
    await signOut();
    expect(events).toEqual(["fetch /revoke", "remove pa.auth", "broadcast signed-out"]);
    expect(readAuth()).toBeNull();
  });
});
