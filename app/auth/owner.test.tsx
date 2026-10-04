// The owner check, the sign-in dialog and its surfaces, sign-out, and the editor's overlay following
// the owner state (plan 50 §50.1, 10 §10.7 app side).
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEditing } from "../edit/boot.ts";
import { memoryStore } from "../edit/idb.ts";
import { overlayEntries, setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "../edit/overlay.ts";
import { loadFixture, startWorld, type Fixture, type World } from "../edit/testkit.ts";
import { getOwner, setOwner } from "../shell/owner.tsx";
import { Toast } from "../shell/toast.tsx";
import { asOwner, byText, click, mount, until, type Mounted } from "../testing.tsx";
import {
  cancelSignIn, checkOwner, continueWithGithub, getAuthUi, onOwnerChange, openSignIn, SAVING_AGAIN,
  setBeforeSignInNavigate, setSignOutGuard, signOutNow, startOwnerCheck, waitForSignIn,
} from "./auth.ts";
import { OwnerAvatar, SignInDialog, SignInLink } from "./AuthUI.tsx";
import { AUTH_KEY, CHANNEL_NAME } from "./config.ts";
import { readAuth } from "./session.ts";

let fx: Fixture;
let w: World;
let mounted: Mounted[];

async function render(node: Parameters<typeof mount>[0]): Promise<Mounted> {
  const m = await mount(node);
  mounted.push(m);
  return m;
}

const prepared = (): Promise<unknown> => until(() => getAuthUi().prepared, "the sign-in attempt to be prepared");

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  mounted = [];
  w = startWorld(fx);
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  act(() => {
    cancelSignIn();
    setOwner({ owner: false });
  });
  onOwnerChange(() => {});
  setSignOutGuard(async () => true);
  setBeforeSignInNavigate(() => {});
  stopOverlay();
  w.stop();
});

describe("the owner check", () => {
  it("is a visitor without a stored sign-in, and asks GitHub nothing", async () => {
    localStorage.removeItem(AUTH_KEY);
    expect(await checkOwner()).toBe(false);
    expect(getOwner().owner).toBe(false);
    expect(w.fake.requests.some((r) => new URL(r.url).pathname === "/user")).toBe(false);
  });

  it("makes the site owner with push the owner, telling the editor once", async () => {
    const hook = vi.fn<(owner: boolean) => void>();
    onOwnerChange(hook);
    expect(await checkOwner()).toBe(true);
    expect(getOwner()).toEqual({ owner: true, login: "kaitlyla", avatarUrl: w.fake.user.avatar_url });
    expect(hook.mock.calls).toEqual([[true]]);
    expect(await checkOwner()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("signs a different GitHub account out at once", async () => {
    w.fake.user = { login: "someone", id: 1, avatar_url: "x" };
    expect(await checkOwner()).toBe(false);
    expect(getOwner().owner).toBe(false);
    expect(readAuth()).toBeNull();
  });

  it("does not make the owner's account the owner without push on the repository", async () => {
    w.fake.push = false;
    expect(await checkOwner()).toBe(false);
    expect(getOwner().owner).toBe(false);
  });

  it("keeps the previous state when GitHub can't be reached", async () => {
    expect(await checkOwner()).toBe(true);
    w.fake.fail(() => true, "network", 100);
    expect(await checkOwner()).toBe(true);
    expect(getOwner().owner).toBe(true);
  });
});

describe("the sign-in dialog", () => {
  it("opens and prepares a PKCE S256 attempt", async () => {
    openSignIn("normal");
    expect(getAuthUi().dialog).toBe("normal");
    await prepared();
    const url = getAuthUi().prepared?.url ?? "";
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("code_challenge=");
  });

  it("waits for sign-in in the expired form, and cancelling resolves it false and closes the dialog", async () => {
    const waiting = waitForSignIn();
    expect(getAuthUi().dialog).toBe("expired");
    cancelSignIn();
    expect(await waiting).toBe(false);
    expect(getAuthUi().dialog).toBeNull();
  });

  it("with the popup blocked, runs the before-navigate step, saying whether a save is waiting", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = vi.fn<(saveWaiting: boolean) => void>();
    setBeforeSignInNavigate(before);

    void waitForSignIn();
    await prepared();
    continueWithGithub();
    expect(before.mock.calls).toEqual([[true]]);

    cancelSignIn();
    before.mockClear();
    openSignIn("normal");
    await prepared();
    continueWithGithub();
    await vi.waitFor(() => expect(before.mock.calls).toEqual([[false]]));

    before.mockClear();
    open.mockReturnValue({} as unknown as Window);
    await prepared();
    continueWithGithub();
    await new Promise((r) => setTimeout(r, 20));
    expect(open).toHaveBeenCalledTimes(3);
    expect(before).not.toHaveBeenCalled();
  });

  it("closes and runs the waiting save when sign-in finishes in another tab", async () => {
    startOwnerCheck();
    await until(() => getOwner().owner, "the startup owner check");
    const waiting = waitForSignIn();
    await render(<Toast />);
    const other = new BroadcastChannel(CHANNEL_NAME);
    try {
      let signedIn: boolean | null = null;
      await act(async () => {
        other.postMessage({ type: "signed-in" });
        signedIn = await waiting;
      });
      expect(signedIn).toBe(true);
    } finally {
      other.close();
    }
    expect(getAuthUi().dialog).toBeNull();
    await until(() => document.body.textContent?.includes(SAVING_AGAIN), "the saving-again toast");
  });
});

describe("sign out", () => {
  it("does nothing when the unsaved-changes check says stay", async () => {
    expect(await checkOwner()).toBe(true);
    setSignOutGuard(async () => false);
    await signOutNow();
    expect(readAuth()).not.toBeNull();
    expect(getOwner().owner).toBe(true);
  });

  it("clears the stored sign-in and the owner state", async () => {
    expect(await checkOwner()).toBe(true);
    setSignOutGuard(async () => true);
    await signOutNow();
    expect(readAuth()).toBeNull();
    expect(getOwner().owner).toBe(false);
  });
});

describe("sign-in surfaces", () => {
  it("SignInLink offers Owner sign-in to visitors and Sign out to her", async () => {
    const { container } = await render(<SignInLink />);
    const signIn = byText(container, "button", "Owner sign-in");
    expect(signIn).not.toBeNull();
    await click(signIn);
    expect(getAuthUi().dialog).toBe("normal");
    asOwner(true);
    expect(byText(container, "button", "Sign out")).not.toBeNull();
    expect(byText(container, "button", "Owner sign-in")).toBeNull();
  });

  it("OwnerAvatar shows her avatar only when she is the owner", async () => {
    const { container } = await render(<OwnerAvatar />);
    expect(container.innerHTML).toBe("");
    act(() => setOwner({ owner: true, login: "kaitlyla", avatarUrl: "https://example.test/a.png" }));
    const img = container.querySelector<HTMLImageElement>('[data-ref="signed-in-indicator"] img');
    expect(img?.getAttribute("src")).toBe("https://example.test/a.png");
  });

  it("SignInDialog enables Continue once prepared, and Cancel closes it", async () => {
    const { container } = await render(<SignInDialog />);
    act(() => openSignIn("expired"));
    expect(container.querySelector("h2")?.textContent).toBe("Sign in again to finish saving");
    const cont = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>('[data-ref="github-continue"]');
    expect(cont()?.disabled).toBe(true);
    await until(() => cont()?.disabled === false, "Continue to be enabled");
    await click(container.querySelector('[data-ref="sign-in-cancel"]'));
    expect(container.querySelector('[data-ref="sign-in-dialog"]')).toBeNull();
    expect(getAuthUi().dialog).toBeNull();
  });
});

describe("edit boot", () => {
  it("loads the stored overlay when she becomes the owner and drops it when she signs out", async () => {
    startEditing();
    const store = memoryStore<OverlayEntry>();
    await store.put("content/x.json", { commit: "0123456789abcdef0123456789abcdef01234567", json: {} });
    setOverlayStoreForTests(store);

    expect(await checkOwner()).toBe(true);
    await vi.waitFor(() => expect(overlayEntries().has("content/x.json")).toBe(true));

    await signOutNow();
    expect(getOwner().owner).toBe(false);
    expect(overlayEntries().size).toBe(0);
  });
});
