/* app.js — wg-admin client behaviour
 *
 * Small and dependency-free apart from htmx (page swaps) and the QR library.
 *   - ticks the running-cost meter and the auto-destroy countdown every second
 *   - makes WireGuard client keys in the browser; the private key never leaves
 *   - fills the config template, draws the QR, offers a download
 *   - enables the Tear down button only when the confirmation word is typed
 */
(function () {
  "use strict";

  // ── Live counters ───────────────────────────────────────────────────────
  function fmtGbp(n) {
    return "£" + (n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2));
  }
  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
    if (m > 0) return m + "m " + String(sec).padStart(2, "0") + "s";
    return sec + "s";
  }
  function tick() {
    var now = Date.now();
    document.querySelectorAll("[data-cost-since]").forEach(function (el) {
      var since = Date.parse(el.getAttribute("data-cost-since"));
      var rate = parseFloat(el.getAttribute("data-rate") || "0");
      if (!isFinite(since)) return;
      el.textContent = fmtGbp(Math.max(0, (now - since) / 3600000) * rate);
    });
    document.querySelectorAll("[data-until]").forEach(function (el) {
      var until = Date.parse(el.getAttribute("data-until"));
      if (!isFinite(until)) return;
      var left = until - now;
      el.textContent = left <= 0 ? "now" : fmtDuration(left);
    });
    document.querySelectorAll("[data-since]").forEach(function (el) {
      var since = Date.parse(el.getAttribute("data-since"));
      if (!isFinite(since)) return;
      el.textContent = fmtDuration(now - since);
    });
  }
  setInterval(tick, 1000);
  document.addEventListener("htmx:afterSwap", tick);
  tick();

  // ── Keep the carrier animation continuous across re-renders ─────────────
  // The Overview is replaced every 20 s, which would restart the dash
  // animation from zero and make it jump. Starting each new copy at the phase
  // the wall clock implies makes the swap invisible.
  function syncCarrier(root) {
    (root || document).querySelectorAll(".tunnel .carrier").forEach(function (el) {
      var dur = parseFloat(getComputedStyle(el).animationDuration) || 0;
      if (!dur) return;
      el.style.animationDelay = (-((Date.now() / 1000) % dur)).toFixed(3) + "s";
    });
  }
  syncCarrier();
  document.addEventListener("htmx:afterSwap", function (e) { syncCarrier(e.target); });

  // ── Remember collapsed panels across the 20-second refresh ──────────────
  // The Overview re-renders itself; without this, a panel you collapsed would
  // spring open again. The choice is kept in this browser only.
  var PANEL_KEY = "wg-admin:panels";
  function panelPrefs() {
    try { return JSON.parse(localStorage.getItem(PANEL_KEY) || "{}"); } catch (e) { return {}; }
  }
  function applyPanelPrefs(root) {
    var prefs = panelPrefs();
    (root || document).querySelectorAll("details[data-panel]").forEach(function (d) {
      var k = d.getAttribute("data-panel");
      if (k in prefs) d.open = !!prefs[k];
    });
  }
  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (!d || !d.matches || !d.matches("details[data-panel]")) return;
    var prefs = panelPrefs();
    prefs[d.getAttribute("data-panel")] = d.open;
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(prefs)); } catch (err) { /* private mode */ }
  }, true);
  applyPanelPrefs();
  document.addEventListener("htmx:afterSwap", function (e) { applyPanelPrefs(e.target); });
  // Apply before paint on swaps too, so there is no flash of the panel opening.
  document.addEventListener("htmx:afterSettle", function (e) { applyPanelPrefs(e.target); });

  // ── Modals ─────────────────────────────────────────────────────────────
  // Native <dialog>. The Overview re-renders itself every 20 s, which would
  // replace an open dialog mid-read, so while one is open the refresh is
  // skipped; the moment it closes, fresh data is fetched.
  function showModal(id) {
    var d = document.getElementById(id);
    if (d && !d.open) d.showModal();
  }
  function anyModalOpen() { return !!document.querySelector("dialog.modal[open], .sheet.open"); }

  // ── Sheets (phone) ─────────────────────────────────────────────────────
  // On a phone, detail panels (class "sheet") stay hidden until a button with
  // data-sheet="<id>" opens one; it slides up from the bottom. Done, the
  // backdrop or Escape closes it. The page's own refresh waits while one is
  // open (see anyModalOpen), and a sheet replaced by a refresh simply closes.
  function closeSheets() {
    document.querySelectorAll(".sheet.open").forEach(function (x) { x.classList.remove("open"); });
    document.documentElement.classList.remove("sheet-open");
  }
  function openSheet(id) {
    var el = document.getElementById(id);
    if (!el) return;
    closeSheets();
    el.classList.add("open");
    document.documentElement.classList.add("sheet-open");
    el.scrollTop = 0;
  }
  document.addEventListener("click", function (e) {
    var o = e.target.closest("[data-sheet]");
    if (o) { e.preventDefault(); openSheet(o.getAttribute("data-sheet")); return; }
    if (e.target.closest("[data-sheet-close]")) { closeSheets(); return; }
    if (e.target.closest("[data-reveal-close]")) { var r = document.getElementById("peer-reveal"); if (r) r.hidden = true; }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSheets(); });
  document.addEventListener("htmx:afterSwap", function () {
    if (!document.querySelector(".sheet.open")) document.documentElement.classList.remove("sheet-open");
  });
  // Moving to another tab starts clean.
  document.addEventListener("htmx:beforeRequest", function (e) {
    var el = e.detail && e.detail.elt;
    if (el && el.tagName === "A") closeSheets();
  });
  document.addEventListener("click", function (e) {
    var o = e.target.closest("[data-open]");
    if (o) { showModal(o.getAttribute("data-open")); return; }
    var c = e.target.closest("[data-close]");
    if (c) { var d = c.closest("dialog"); if (d) d.close(); return; }
    // click on the backdrop (the dialog element itself, outside .modal-box)
    if (e.target.tagName === "DIALOG" && e.target.classList.contains("modal")) e.target.close();
  });
  document.addEventListener("htmx:beforeRequest", function (e) {
    // Hold the periodic refresh while reading a modal.
    var el = e.detail && e.detail.elt;
    if (el && el.id === "live" && anyModalOpen()) e.preventDefault();
  });
  document.addEventListener("close", function (e) {
    if (e.target.tagName !== "DIALOG" || !e.target.classList.contains("modal")) return;
    var live = document.getElementById("live");
    if (live && window.htmx) htmx.ajax("GET", "/partials/live", { target: "#live", swap: "outerHTML", select: "#live" });
  }, true);

  // ── Hover panels on the tunnel tiles ───────────────────────────────────
  // Hover or keyboard focus shows; tap toggles (phones have no hover). Only
  // one panel at a time. Panels are re-rendered with the Overview, so nothing
  // here holds state.
  function tipFor(el) { return document.getElementById(el.getAttribute("data-tip")); }
  function hideTips() { document.querySelectorAll(".tip").forEach(function (t) { t.hidden = true; }); }
  var hoverable = window.matchMedia && window.matchMedia("(hover: hover)").matches;
  document.addEventListener("mouseover", function (e) {
    if (!hoverable) return;
    var h = e.target.closest("[data-tip]"); if (!h) return;
    var t = tipFor(h); if (!t) return;
    hideTips(); t.hidden = false;
  });
  document.addEventListener("mouseout", function (e) {
    if (!hoverable) return;
    var h = e.target.closest("[data-tip]"); if (!h) return;
    var to = e.relatedTarget;
    if (to && (h.contains(to) || (tipFor(h) && tipFor(h).contains(to)))) return;
    // allow moving the pointer onto the panel itself
    setTimeout(function () {
      var t = tipFor(h);
      if (t && !t.matches(":hover") && !h.matches(":hover")) t.hidden = true;
    }, 120);
  });
  document.addEventListener("mouseleave", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("tip")) e.target.hidden = true;
  }, true);
  document.addEventListener("focusin", function (e) { var h = e.target.closest && e.target.closest("[data-tip]"); if (h) { hideTips(); var t = tipFor(h); if (t) t.hidden = false; } });
  document.addEventListener("focusout", function (e) { var h = e.target.closest && e.target.closest("[data-tip]"); if (h) { var t = tipFor(h); if (t) setTimeout(function () { if (!t.contains(document.activeElement)) t.hidden = true; }, 100); } });
  document.addEventListener("click", function (e) {
    var h = e.target.closest("[data-tip]");
    if (h) { var t = tipFor(h); if (t) { var was = t.hidden; hideTips(); t.hidden = !was; } return; }
    if (!e.target.closest(".tip")) hideTips();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hideTips(); });

  // ── Install as an app (Settings > Install on your phone) ────────────────
  // Chrome on Android offers installation through a "beforeinstallprompt"
  // event: keep it and fire it from our own button. Safari on iPhone has no
  // such event, so there the panel shows the Share-sheet steps instead.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () { /* the dashboard works without it */ });
  }
  var installPrompt = null;
  function isInstalled() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  }
  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isPhone() { return window.matchMedia && window.matchMedia("(max-width: 900px) and (pointer: coarse)").matches; }
  function renderInstall(root) {
    (root || document).querySelectorAll("[data-install-panel]").forEach(function (p) {
      var state = p.querySelector("[data-install-state]");
      var show = function (sel, on) { var el = p.querySelector(sel); if (el) el.hidden = !on; };
      var installed = isInstalled();
      show("[data-install-android]", !installed && !!installPrompt);
      show("[data-install-ios]", !installed && isIos());
      show("[data-install-other]", !installed && !isIos() && !installPrompt && isPhone());
      show("[data-install-desktop]", !installed && !isPhone() && !isIos());
      if (state) state.innerHTML = installed
        ? "<span class='pill up'>installed</span> You are using wg-admin as an app."
        : installPrompt ? "Ready to install on this device."
        : isIos() ? "iPhone and iPad install from Safari's Share menu:"
        : isPhone() ? "Install from the browser menu:"
        : "";
      var qr = p.querySelector("[data-qr-text]");
      if (qr && !qr.firstChild && typeof qrcode === "function" && qr.getAttribute("data-qr-text")) drawQr(qr, qr.getAttribute("data-qr-text"));
    });
    // Once installed, the Settings button that leads here is not needed.
    (root || document).querySelectorAll("[data-install-link]").forEach(function (b) { b.hidden = isInstalled(); });
  }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); installPrompt = e; renderInstall(); });
  window.addEventListener("appinstalled", function () { installPrompt = null; renderInstall(); });
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-install]") || !installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.finally(function () { installPrompt = null; renderInstall(); });
  });
  document.addEventListener("DOMContentLoaded", function () { renderInstall(); });
  document.addEventListener("htmx:afterSwap", function (e) { renderInstall(e.target); });
  setTimeout(renderInstall, 0);

  // ── Confirmation word gate ──────────────────────────────────────────────
  function wireConfirm(root) {
    (root || document).querySelectorAll("[data-confirm-word]").forEach(function (input) {
      var word = input.getAttribute("data-confirm-word");
      var btn = input.form && input.form.querySelector("button[type=submit]");
      if (!btn) return;
      var update = function () { btn.disabled = input.value.trim().toLowerCase() !== word; };
      input.addEventListener("input", update);
      update();
    });
  }
  wireConfirm();
  document.addEventListener("htmx:afterSwap", function (e) { wireConfirm(e.target); });

  // ── Secret reveal (the SSH password panel) ─────────────────────────────
  document.addEventListener("click", function (e) {
    var r = e.target.closest("[data-reveal]");
    var c = e.target.closest("[data-copy-secret]");
    if (!r && !c) return;
    var row = (r || c).closest("tr");
    var val = row.querySelector("[data-secret]");
    var mask = row.querySelector(".secret-mask");
    if (r) {
      var show = val.hidden;
      val.hidden = !show; mask.hidden = show;
      r.textContent = show ? "Hide" : "Show";
    } else {
      navigator.clipboard.writeText(val.getAttribute("data-secret")).then(function () {
        var old = c.textContent; c.textContent = "Copied"; setTimeout(function () { c.textContent = old; }, 1200);
      });
    }
  });

  // ── Copy buttons ────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (!b) return;
    var target = document.querySelector(b.getAttribute("data-copy"));
    if (!target) return;
    navigator.clipboard.writeText(target.textContent).then(function () {
      var old = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = old; }, 1200);
    });
  });

  // ── WireGuard keys in the browser ───────────────────────────────────────
  function b64(bytes) { return btoa(String.fromCharCode.apply(null, bytes)); }
  function b64urlToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  async function genKeypair() {
    if (!window.crypto || !crypto.subtle) throw new Error("This browser has no WebCrypto. Use a current Chrome, Safari or Firefox.");
    var kp;
    try {
      kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    } catch (e) {
      throw new Error("This browser cannot make X25519 keys yet (needs Chrome 133+, Safari 17+ or Firefox 130+). Try another browser, or make the peer with 'npm run peer' on the laptop.");
    }
    var jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    return { privateKey: b64(b64urlToBytes(jwk.d)), publicKey: b64(b64urlToBytes(jwk.x)) };
  }

  function drawQr(el, text) {
    if (typeof qrcode !== "function") { el.textContent = "QR library missing"; return; }
    var qr = qrcode(0, "M"); qr.addData(text); qr.make();
    el.innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  }

  // Show a finished config: QR, text, download. The private key only ever
  // lives in this page's memory and in the file the person saves.
  function showConfig(peer, template, privateKey) {
    var conf = template.replace("__CLIENT_PRIVATE_KEY__", privateKey);
    var reveal = document.getElementById("peer-reveal");
    closeSheets();
    reveal.hidden = false;
    reveal.querySelector("[data-peer-name]").textContent = peer.name;
    reveal.querySelector("[data-peer-ip]").textContent = peer.ip;
    reveal.querySelector("#peer-conf").textContent = conf;
    drawQr(reveal.querySelector(".qr"), conf);
    var dl = reveal.querySelector("[data-download]");
    if (dl.href && dl.href.indexOf("blob:") === 0) URL.revokeObjectURL(dl.href);
    dl.href = URL.createObjectURL(new Blob([conf], { type: "text/plain" }));
    // The WireGuard apps use the file name as the tunnel name: letters, digits,
    // dashes and underscores, at most 15 characters on Windows.
    dl.download = peer.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 15).toLowerCase() + ".conf";
    reveal.scrollIntoView({ behavior: "smooth", block: "start" });
    if (window.htmx) htmx.ajax("GET", "/partials/peers-table", { target: "#peers-table", swap: "outerHTML" });
  }

  // The add-client form. Bound at the document level (not on the form) because
  // htmx swaps the page body when you move between tabs, so a handler attached
  // to the form at first load would be lost. Capture phase, so it runs before
  // htmx's own submit handling.
  document.addEventListener("submit", async function (e) {
    var form = e.target;
    if (!form || form.id !== "add-peer") return;
    e.preventDefault();
    e.stopPropagation();
    var status = document.getElementById("add-peer-status");
    var btn = form.querySelector("button[type=submit]");
    status.textContent = "Making keys…"; btn.disabled = true;
    try {
      var keys = await genKeypair();
      var fd = new FormData(form);
      var r = await fetch("/api/peers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fd.get("name"), public_key: keys.publicKey, full_tunnel: fd.get("full_tunnel") === "1", azure_vnet: fd.get("azure_vnet") === "1", tunnel_dns: fd.get("tunnel_dns") === "1", home_lan: fd.get("home_lan") === "1" }),
      });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || ("Failed (" + r.status + ")"));
      status.textContent = "";
      form.reset();
      showConfig(data.peer, data.template, keys.privateKey);
    } catch (err) {
      status.textContent = err.message;
      alert("Could not add the client: " + err.message);
    } finally {
      btn.disabled = false;
    }
  }, true);

  // "Get config" on an existing client: new keys, then the same reveal.
  document.addEventListener("click", async function (e) {
    var b = e.target.closest("[data-rekey]");
    if (!b) return;
    var id = b.getAttribute("data-rekey"), name = b.getAttribute("data-name");
    if (!confirm("Make new keys for \"" + name + "\" and download its config? Any config it already has stops working within 30 seconds.")) return;
    var old = b.textContent; b.textContent = "Making keys…"; b.disabled = true;
    try {
      var keys = await genKeypair();
      var r = await fetch("/api/peers/" + id + "/rekey", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_key: keys.publicKey }),
      });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || ("Failed (" + r.status + ")"));
      showConfig(data.peer, data.template, keys.privateKey);
    } catch (err) {
      alert(err.message);
    } finally {
      b.textContent = old; b.disabled = false;
    }
  });
})();
