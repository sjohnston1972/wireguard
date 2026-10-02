import "./testSetup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { renderRouted } from "./testRender";
import { NO_X25519, PRIVATE_KEY_SLOT } from "@/lib/wgkeys";
import { clientRoutes, NOW } from "./testData";

// crypto.subtle is replaced by a stand-in that makes a new, known key pair on
// every call: key pair n has a private key of 32 bytes of n and a public key
// of 32 bytes of 100 + n, so a test can look for exactly those strings.

const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const b64url = (n: number) => b64(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const privateKey = (n: number) => b64(n);
const publicKey = (n: number) => b64(100 + n);

let made = 0;
function stubCrypto() {
  made = 0;
  const subtle = {
    generateKey: vi.fn(async () => {
      made++;
      const n = made;
      return { privateKey: { n }, publicKey: { n } };
    }),
    exportKey: vi.fn(async (_format: string, key: { n: number }) => ({ kty: "OKP", crv: "X25519", d: b64url(key.n), x: b64url(100 + key.n) })),
  };
  vi.stubGlobal("crypto", { subtle, getRandomValues: <T,>(a: T) => a, randomUUID: () => "00000000-0000-4000-8000-000000000000" });
}

const TEMPLATE = `[Interface]\nPrivateKey = ${PRIVATE_KEY_SLOT}\nAddress = 10.13.13.15/32\n\n[Peer]\nPublicKey = ${"S".repeat(43)}=\nEndpoint = wg.example.net:51820\nAllowedIPs = 10.13.13.0/24, 10.13.13.1/32\nPersistentKeepalive = 25\n`;
const added = (name = "tablet") => ({
  peer: { id: 9, name, ip: "10.13.13.15", public_key: publicKey(1), enabled: 1, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: NOW, note: null },
  template: TEMPLATE,
});

let saved: { name: string; text: Promise<string> }[] = [];
beforeEach(() => {
  stubCrypto();
  saved = [];
  // jsdom has no object URLs; record what the .conf download hands the browser.
  const blobs = new Map<string, Blob>();
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      const u = `blob:test/${blobs.size}`;
      blobs.set(u, b);
      return u;
    }),
    revokeObjectURL: vi.fn((u: string) => blobs.delete(u)),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const b = blobs.get(this.href);
    if (b) saved.push({ name: this.download, text: b.text() });
  });
});
afterEach(() => vi.restoreAllMocks());

const dialog = () => screen.findByRole("dialog", { name: "Add client" });

async function fillName(user: ReturnType<typeof userEvent.setup>, d: HTMLElement, name = "tablet") {
  await user.type(within(d).getByLabelText("Name"), name);
  await user.click(within(d).getByRole("button", { name: "Next" }));
}

async function toDelivery(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add client" }));
  const d = await dialog();
  await fillName(user, d);
  await user.click(within(d).getByRole("button", { name: "Next" })); // routing: standard
  await user.click(within(d).getByRole("button", { name: "Create client" })); // expiry: never
  await within(d).findByRole("img", { name: /QR code/ });
  return d;
}

describe("Add-client wizard", { timeout: 30_000 }, () => {
  it("routing step shows the exact AllowedIPs for each choice", async () => {
    const user = userEvent.setup();
    renderApp("/clients", { routes: clientRoutes() });
    await screen.findByRole("table", { name: "Clients" });
    await user.click(screen.getByRole("button", { name: "Add client" }));
    const d = await dialog();
    await fillName(user, d);

    const ips = () => within(d).getByRole("status", { name: "AllowedIPs" }).textContent;
    expect(within(d).getByRole("radio", { name: /Standard/ })).toBeChecked();
    expect(ips()).toBe("10.13.13.0/24, 10.13.13.1/32, fd13:13::/64");

    await user.click(within(d).getByRole("checkbox", { name: /Home LAN/ }));
    expect(ips()).toBe("10.13.13.0/24, 10.13.13.1/32, fd13:13::/64, 192.168.1.0/24");
    await user.click(within(d).getByRole("checkbox", { name: /Azure VNet/ }));
    expect(ips()).toBe("10.13.13.0/24, 10.13.13.1/32, fd13:13::/64, 10.50.0.0/16, 192.168.1.0/24");
    await user.click(within(d).getByRole("checkbox", { name: /Home LAN/ }));
    expect(ips()).toBe("10.13.13.0/24, 10.13.13.1/32, fd13:13::/64, 10.50.0.0/16");

    await user.click(within(d).getByRole("radio", { name: /Full tunnel/ }));
    expect(ips()).toBe("0.0.0.0/0, ::/0");
    expect(within(d).getByRole("checkbox", { name: /Azure VNet/ })).toBeDisabled();
    expect(within(d).getByRole("checkbox", { name: /Home LAN/ })).toBeDisabled();
  });

  it("the private key is never sent and is gone after close", async () => {
    const user = userEvent.setup();
    let posts = 0;
    const { fetchMock, client } = renderApp("/clients", {
      routes: { ...clientRoutes(), "POST /api/v1/clients": () => added(++posts === 1 ? "tablet" : "tablet") },
    });
    await screen.findByRole("table", { name: "Clients" });

    // First run: through to Delivery, then Done.
    const d = await toDelivery(user);
    expect(made).toBe(1);
    const post = fetchMock!.callsTo("POST", "/api/v1/clients")[0]!;
    expect(post.body).toEqual({ name: "tablet", public_key: publicKey(1), full_tunnel: false, azure_vnet: false, tunnel_dns: false, home_lan: false, expires_days: 0 });

    // The finished config is offered three ways, and only here.
    expect(within(d).getByRole("button", { name: "Copy config" })).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: /Download \.conf/ }));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("tablet.conf");
    expect(await saved[0]!.text).toContain(`PrivateKey = ${privateKey(1)}`);
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    await user.click(within(d).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(privateKey(1));

    // Second run: closed with Escape from the Delivery step.
    await toDelivery(user);
    expect(made).toBe(2);
    expect(document.body.innerHTML).toContain(privateKey(2)); // shown once, while open
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(privateKey(2));

    // Never sent, never cached, never stored.
    for (const k of [privateKey(1), privateKey(2)]) {
      for (const c of fetchMock!.calls) {
        expect(c.url).not.toContain(k);
        expect(JSON.stringify(c.body ?? null)).not.toContain(k);
        expect(String(c.init.body ?? "")).not.toContain(k);
      }
      const cached = JSON.stringify([
        client.getQueryCache().getAll().map((q) => q.state.data),
        client.getMutationCache().getAll().map((m) => [m.state.variables, m.state.data]),
      ]);
      expect(cached).not.toContain(k);
      expect(JSON.stringify({ ...localStorage })).not.toContain(k);
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(k);
    }
  });

  it("a server error keeps the name and routing but makes a fresh key on retry", async () => {
    const user = userEvent.setup();
    let posts = 0;
    const { fetchMock } = renderApp("/clients", {
      routes: {
        ...clientRoutes(),
        "POST /api/v1/clients": () => (++posts === 1 ? { status: 500, json: { error: { code: "upstream", message: "The database is busy." } } } : added()),
      },
    });
    await screen.findByRole("table", { name: "Clients" });
    await user.click(screen.getByRole("button", { name: "Add client" }));
    const d = await dialog();
    await fillName(user, d);
    await user.click(within(d).getByRole("checkbox", { name: /Azure VNet/ }));
    await user.click(within(d).getByRole("button", { name: "Next" }));
    await user.click(within(d).getByRole("radio", { name: /7 days/ }));
    await user.click(within(d).getByRole("button", { name: "Create client" }));

    expect(await within(d).findByText("The database is busy.")).toBeInTheDocument();
    expect(within(d).queryByRole("img", { name: /QR code/ })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(privateKey(1));

    // The input is kept: back to the routing and the name, all as entered.
    await user.click(within(d).getByRole("button", { name: "Back" }));
    expect(within(d).getByRole("checkbox", { name: /Azure VNet/ })).toBeChecked();
    await user.click(within(d).getByRole("button", { name: "Back" }));
    expect(within(d).getByLabelText("Name")).toHaveValue("tablet");
    await user.click(within(d).getByRole("button", { name: "Next" }));
    await user.click(within(d).getByRole("button", { name: "Next" }));
    expect(within(d).getByRole("radio", { name: /7 days/ })).toBeChecked();

    await user.click(within(d).getByRole("button", { name: "Create client" }));
    await within(d).findByRole("img", { name: /QR code/ });

    const [first, second] = fetchMock!.callsTo("POST", "/api/v1/clients").map((c) => c.body as Record<string, unknown>);
    expect(first).toMatchObject({ name: "tablet", azure_vnet: true, expires_days: 7, public_key: publicKey(1) });
    expect(second).toMatchObject({ name: "tablet", azure_vnet: true, expires_days: 7, public_key: publicKey(2) });
    expect(made).toBe(2);
    expect(document.body.innerHTML).toContain(privateKey(2));
    expect(document.body.innerHTML).not.toContain(privateKey(1));
  });

  it("a name the server refuses is shown at the name field, input kept", async () => {
    const user = userEvent.setup();
    renderApp("/clients", {
      routes: { ...clientRoutes(), "POST /api/v1/clients": { status: 400, json: { error: { code: "bad_input", message: "Name: letters, digits, spaces, dashes; up to 32 characters.", field: "name" } } } },
    });
    await screen.findByRole("table", { name: "Clients" });
    await user.click(screen.getByRole("button", { name: "Add client" }));
    const d = await dialog();
    await fillName(user, d);
    await user.click(within(d).getByRole("button", { name: "Next" }));
    await user.click(within(d).getByRole("button", { name: "Create client" }));
    const name = await within(d).findByLabelText("Name");
    expect(name).toHaveValue("tablet");
    expect(name).toHaveAccessibleDescription(/letters, digits/);
  });

  it("a browser without X25519 shows the message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", { subtle: { generateKey: () => Promise.reject(new DOMException("Unrecognized name.", "NotSupportedError")) } });
    const { fetchMock } = renderApp("/clients", { routes: clientRoutes() });
    await screen.findByRole("table", { name: "Clients" });
    await user.click(screen.getByRole("button", { name: "Add client" }));
    const d = await dialog();
    await fillName(user, d);
    await user.click(within(d).getByRole("button", { name: "Next" }));
    await user.click(within(d).getByRole("button", { name: "Create client" }));
    expect(await within(d).findByText(NO_X25519)).toBeInTheDocument();
    expect(fetchMock!.callsTo("POST", "/api/v1/clients")).toHaveLength(0);
  });

  it("?action=add opens the wizard", async () => {
    const user = userEvent.setup();
    renderApp("/clients?action=add", { routes: clientRoutes() });
    const d = await dialog();
    expect(within(d).getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "location", hidden: true })).toHaveTextContent("/clients?action=add");
    await user.click(within(d).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status", { name: "location", hidden: true })).toHaveTextContent(/^\/clients$/);
  });

  it("leaving the page while the config is shown drops it", async () => {
    const user = userEvent.setup();
    const { router } = renderRouted("/clients", { ...clientRoutes(), "POST /api/v1/clients": added() });
    await screen.findByRole("table", { name: "Clients" });
    await toDelivery(user);
    expect(document.body.innerHTML).toContain(privateKey(1));
    await act(() => router.navigate("/firewall"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(privateKey(1));
  });

  it("Get new config sends only the new public key and shows the config once", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/clients/3", {
      routes: { ...clientRoutes(), "POST /api/v1/clients/3/rekey": { ...added("laptop"), peer: { ...added("laptop").peer, id: 3, ip: "10.13.13.4" } } },
    });
    const p = await screen.findByRole("complementary", { name: "laptop" });
    await user.click(within(p).getByRole("button", { name: "Get new config" }));
    const d = await screen.findByRole("dialog", { name: "Get new config for laptop" });
    await user.click(within(d).getByRole("button", { name: "Make new keys" }));
    await within(d).findByRole("img", { name: /QR code/ });
    expect(fetchMock!.callsTo("POST", "/api/v1/clients/3/rekey")[0]!.body).toEqual({ public_key: publicKey(1) });
    expect(document.body.innerHTML).toContain(privateKey(1));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(privateKey(1));
  });
});
