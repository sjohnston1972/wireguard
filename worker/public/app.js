/* app.js — wg-admin client behaviour
 *
 * Small and dependency-free apart from htmx (page swaps) and the QR library.
 *   - ticks the running-cost meter and the auto-destroy countdown every second
 *   - makes WireGuard client keys in the browser; the private key never leaves
 *   - fills the config template, draws the QR, offers a download
 *   - enables the Tear down button only when the confirmation word is typed
 *   - keeps secrets out of the browser's saved pages, and says so when a
 *     request fails (usually an expired sign-in)
 */
(function () {
  "use strict";

  // ── Keep secrets out of the browser's storage ───────────────────────────
  // htmx normally saves a copy of each page in the browser's local storage
  // before moving to another tab, so Back is instant. A copy of the Clients
  // page taken just after adding a client would hold that client's private
  // key, and it would stay on disk. So: no saved copies at all (Back simply
  // reloads the page), and any copy an older version left behind is deleted.
  if (window.htmx) htmx.config.historyCacheSize = 0;
  try { localStorage.removeItem("htmx-history-cache"); } catch (e) { /* private mode */ }
  document.addEventListener("htmx:beforeHistorySave", function () {
    closeReveal();
    document.querySelectorAll("[data-secret]").forEach(function (v) { hideSecret(v.closest("tr")); });
  });

  // ── When a request fails ────────────────────────────────────────────────
  // htmx quietly ignores a request that fails, so a Deploy press could do
  // nothing with no word why. The usual cause is the Cloudflare sign-in
  // having expired: the request is sent off to the sign-in page and the
  // browser refuses to follow. Show a bar that says so, with a Reload
  // button (which goes through the sign-in again).
  function showNetError(text) {
    var bar = document.getElementById("net-error");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "net-error";
      bar.className = "notice bad net-error";
      bar.setAttribute("role", "alert");
      bar.innerHTML = "<p></p><span class='spacer'></span><button type='button' data-reload>Reload</button>";
      var main = document.querySelector("main") || document.body;
      main.insertBefore(bar, main.firstChild);
    }
    bar.querySelector("p").textContent = text;
  }
  function clearNetError() { var bar = document.getElementById("net-error"); if (bar) bar.remove(); }
  document.addEventListener("htmx:sendError", function () {
    showNetError(navigator.onLine === false
      ? "No connection. The dashboard needs the internet; the VPN itself is unaffected."
      : "Could not reach the dashboard. If you have been away a while, your sign-in has probably expired: reload to sign in again.");
  });
  document.addEventListener("htmx:responseError", function (e) {
    var x = e.detail && e.detail.xhr;
    var status = x ? x.status : 0;
    showNetError(status === 401 || status === 403
      ? "The dashboard refused that (" + status + "). Your sign-in has probably expired: reload to sign in again."
      : "The dashboard answered with an error" + (status ? " (" + status + ")" : "") + ". Nothing may have happened; reload to see the current state.");
  });
  document.addEventListener("htmx:afterRequest", function (e) { if (e.detail && e.detail.successful) clearNetError(); });
  document.addEventListener("click", function (e) { if (e.target.closest("[data-reload]")) location.reload(); });

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

  // ── One phone breakpoint ────────────────────────────────────────────────
  // The same width app.css uses for its phone layout (max-width: 640px), so
  // the script and the stylesheet always agree on "this is a phone". If one
  // changes, change the other.
  var PHONE = "(max-width: 640px)";
  function isPhone() { return !!(window.matchMedia && window.matchMedia(PHONE).matches); }

  // ── Sheets (phone) ─────────────────────────────────────────────────────
  // On a phone, detail panels (class "sheet") stay hidden until a button with
  // data-sheet="<id>" opens one; it slides up from the bottom. Done, the
  // backdrop or Escape closes it. The page's own refresh waits while one is
  // open (see anyModalOpen), and a sheet replaced by a refresh simply closes.
  // While open, a sheet behaves as a dialog for screen readers and the
  // keyboard: it is announced as one, Tab stays inside it, and closing it
  // puts focus back on the button that opened it.
  var sheetOpener = null, sheetOpenerId = null;
  function closeSheets() {
    var had = false;
    document.querySelectorAll(".sheet.open").forEach(function (x) {
      had = true;
      x.classList.remove("open");
      x.removeAttribute("role"); x.removeAttribute("aria-modal"); x.removeAttribute("aria-label");
    });
    document.documentElement.classList.remove("sheet-open");
    if (had) {
      // The opener may have been redrawn by a refresh meanwhile: find it again.
      var back = sheetOpener && sheetOpener.isConnected ? sheetOpener : sheetOpenerId ? document.querySelector('[data-sheet="' + sheetOpenerId + '"]') : null;
      if (back && back.offsetParent !== null) back.focus({ preventScroll: true });
    }
    sheetOpener = null; sheetOpenerId = null;
  }
  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"),
      function (x) { return x.offsetParent !== null || x === document.activeElement; }
    );
  }
  function openSheet(id, opener) {
    var el = document.getElementById(id);
    if (!el) return;
    closeSheets();
    sheetOpener = opener || null; sheetOpenerId = id;
    el.classList.add("open");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    var title = el.querySelector(".sheet-head b");
    if (title) el.setAttribute("aria-label", title.textContent);
    document.documentElement.classList.add("sheet-open");
    el.scrollTop = 0;
    var done = el.querySelector(".sheet-head [data-sheet-close]");
    if (done) done.focus({ preventScroll: true });
  }
  document.addEventListener("click", function (e) {
    var o = e.target.closest("[data-sheet]");
    if (o) { e.preventDefault(); openSheet(o.getAttribute("data-sheet"), o); return; }
    if (e.target.closest("[data-sheet-close]")) { closeSheets(); return; }
    if (e.target.closest("[data-reveal-close]")) closeReveal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeSheets(); return; }
    // Keep Tab inside an open sheet.
    if (e.key !== "Tab") return;
    var sheet = document.querySelector(".sheet.open");
    if (!sheet) return;
    var f = focusables(sheet);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1];
    if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener("htmx:afterSwap", function () {
    if (!document.querySelector(".sheet.open")) document.documentElement.classList.remove("sheet-open");
  });
  // A button inside a sheet (Disable, Move up, Delete...): put the sheet away
  // at once and show the button working, instead of leaving the page dimmed
  // behind the backdrop until the answer arrives. Buttons on the page itself
  // show the same "Saving..." while they wait.
  document.addEventListener("htmx:beforeRequest", function (e) {
    var el = e.detail && e.detail.elt;
    if (!el || el.tagName !== "FORM" || !el.closest("#fw")) return;
    var b = el.querySelector("button[type=submit]");
    if (b) { b.disabled = true; b.textContent = "Saving\u2026"; }
    if (el.closest(".sheet.open")) closeSheets();
  });

  // Moving to another tab starts clean, and so does any other button pressed
  // inside a sheet (Deploy, Dismiss...): the answer redraws the page anyway.
  document.addEventListener("htmx:beforeRequest", function (e) {
    var el = e.detail && e.detail.elt;
    if (el && (el.tagName === "A" || (el.tagName === "FORM" && el.closest(".sheet.open")))) closeSheets();
  });
  document.addEventListener("click", function (e) {
    var o = e.target.closest("[data-open]");
    if (o) { showModal(o.getAttribute("data-open")); return; }
    var c = e.target.closest("[data-close]");
    if (c) { var d = c.closest("dialog"); if (d) d.close(); return; }
    // click on the backdrop (the dialog element itself, outside .modal-box)
    if (e.target.tagName === "DIALOG" && e.target.classList.contains("modal")) e.target.close();
  });
  // ── Don't redraw the Overview under your fingers ────────────────────────
  // The Overview redraws itself every 20 seconds (5 while busy). On a desktop
  // the Deploy, Extend and Tear down forms sit inside that redraw, so a
  // refresh would reset the hours and profile you picked, the typed
  // "destroy", and where the keyboard was. So: once you touch one of those
  // forms, the refresh waits until you submit it or leave it alone for two
  // minutes; and whenever a refresh does happen, keyboard focus is put back
  // on the same control.
  var LIVE_HOLD_MS = 120000;
  var liveTouchedAt = 0;
  function markLiveTouched(e) {
    if (e.target && e.target.closest && e.target.closest("#live form")) liveTouchedAt = Date.now();
  }
  document.addEventListener("input", markLiveTouched, true);
  document.addEventListener("change", markLiveTouched, true);
  document.addEventListener("submit", function (e) {
    if (e.target && e.target.closest && e.target.closest("#live")) liveTouchedAt = 0;
  }, true);
  function liveInUse(live) {
    if (Date.now() - liveTouchedAt < LIVE_HOLD_MS) return true;
    var a = document.activeElement;
    return !!(a && live.contains(a) && a.form && a.tagName === "INPUT" && a.type === "text" && a.value.trim() !== "");
  }
  // Where the keyboard was, as "which form, which field", so it can be found
  // again in the redrawn copy.
  var liveFocus = null;
  document.addEventListener("htmx:beforeSwap", function (e) {
    var el = e.detail && e.detail.elt;
    liveFocus = null;
    if (!el || el.id !== "live") return;
    var a = document.activeElement;
    if (!a || !el.contains(a) || a === el) return;
    liveFocus = { action: a.form ? a.form.getAttribute("action") : null, name: a.getAttribute("name"), value: a.getAttribute("value"), tag: a.tagName, text: a.tagName === "BUTTON" ? a.textContent : null };
  });
  document.addEventListener("htmx:afterSettle", function () {
    if (!liveFocus) return;
    var f = liveFocus; liveFocus = null;
    var live = document.getElementById("live");
    if (!live) return;
    var scope = f.action ? live.querySelector('form[action="' + f.action + '"]') : live;
    if (!scope) return;
    var hit = Array.prototype.find.call(scope.querySelectorAll(f.tag.toLowerCase()), function (x) {
      return x.getAttribute("name") === f.name && x.getAttribute("value") === f.value && (f.text === null || x.textContent === f.text);
    });
    if (hit && hit.offsetParent !== null) hit.focus({ preventScroll: true });
  });

  document.addEventListener("htmx:beforeRequest", function (e) {
    // Hold the periodic refresh while reading a modal, or while one of its
    // forms is half filled in.
    var el = e.detail && e.detail.elt;
    if (el && el.id === "live" && (anyModalOpen() || liveInUse(el))) e.preventDefault();
    // The Firewall page refreshes its hit counters every 20 s; hold that while
    // a sheet is open or a rule is half-typed, so nothing you entered is lost.
    if (el && el.id === "fw") {
      var typing = Array.prototype.some.call(el.querySelectorAll(".fw-add input[type=text]"), function (i) { return i.value.trim() !== ""; });
      if (anyModalOpen() || typing || (document.activeElement && el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName))) e.preventDefault();
    }
  });
  document.addEventListener("close", function (e) {
    if (e.target.tagName !== "DIALOG" || !e.target.classList.contains("modal")) return;
    // A closed dialog forgets any password it was showing.
    e.target.querySelectorAll("[data-secret]").forEach(function (v) { hideSecret(v.closest("tr")); });
    var live = document.getElementById("live");
    // Sent "from" #live, so the half-filled-form hold above applies to it too.
    if (live && window.htmx) htmx.ajax("GET", "/partials/live", { source: live, target: "#live", swap: "outerHTML", select: "#live" });
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
  // Turning a phone sideways can cross the phone width; redraw to match.
  if (window.matchMedia) {
    var phoneMq = window.matchMedia(PHONE);
    var onPhoneChange = function () { renderInstall(); if (!isPhone()) closeSheets(); };
    if (phoneMq.addEventListener) phoneMq.addEventListener("change", onPhoneChange);
    else if (phoneMq.addListener) phoneMq.addListener(onPhoneChange);
  }

  // ── Phone alerts (Settings > Phone alerts) ──────────────────────────────
  // Web Push: ask the phone's permission, subscribe with the dashboard's
  // public key, and hand the subscription to the dashboard, which encrypts
  // every alert to it. The alerts themselves are shown by sw.js.
  function keyBytes(b64) {
    var s = b64.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  function deviceLabel() {
    var ua = navigator.userAgent;
    var what = /Android/i.test(ua) ? "Android phone" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "Windows PC" : /Mac/i.test(ua) ? "Mac" : "Device";
    return what + (isInstalled() ? " (app)" : " (browser)");
  }
  function swReady() {
    return Promise.race([navigator.serviceWorker.ready, new Promise(function (_, no) { setTimeout(function () { no(new Error("The app's background worker is not running; reload and try again.")); }, 8000); })]);
  }
  function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  async function renderPush(root) {
    var panels = (root || document).querySelectorAll("[data-push-panel]");
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      var state = p.querySelector("[data-push-state]");
      var on = p.querySelector("[data-push-on]"), test = p.querySelector("[data-push-test]"), off = p.querySelector("[data-push-off]");
      if (!p.getAttribute("data-vapid")) continue;
      if (!pushSupported()) { state.textContent = "This browser cannot receive alerts. On Android use Chrome; on iPhone install the app first (Settings > Install the app)."; continue; }
      if (Notification.permission === "denied") { state.innerHTML = "<span class='pill down'>blocked</span> Notifications are blocked for this site. Allow them in the phone's settings for wg-admin, then come back."; on.hidden = test.hidden = off.hidden = true; continue; }
      var sub = null;
      try { sub = await (await swReady()).pushManager.getSubscription(); } catch (e) { state.textContent = e.message; continue; }
      // The browser having a subscription is only half of it: the dashboard
      // must still have it on its list too. It drops one the push service
      // says is dead, and Remove below drops one by hand, without the phone
      // knowing. So ask.
      var known = null;
      if (sub) {
        try {
          var r = await fetch("/api/push/status?endpoint=" + encodeURIComponent(sub.endpoint), { headers: { Accept: "application/json" } });
          if (r.ok) known = await r.json();
        } catch (e) { /* offline: say what the browser knows */ }
      }
      p.querySelectorAll("[data-push-id]").forEach(function (li) {
        var mine = !!known && known.id !== null && String(known.id) === li.getAttribute("data-push-id");
        var tag = li.querySelector("[data-this-device]");
        if (tag) tag.hidden = !mine;
      });
      if (sub && known && !known.registered) {
        state.innerHTML = "<span class='pill down'>not registered</span> This device was signed up once, but the dashboard no longer sends to it (it was removed, or the phone's push service replaced it). Turn alerts on again.";
        on.hidden = false; test.hidden = true; off.hidden = false;
      } else if (sub) {
        state.innerHTML = known && known.last_error
          ? "<span class='pill down'>failing</span> This device is signed up, but the last alert to it failed. Send a test to check."
          : "<span class='pill up'>on</span> This device gets alerts." + (known ? "" : " (Could not check with the dashboard just now.)");
        on.hidden = true; test.hidden = false; off.hidden = false;
      } else {
        state.innerHTML = "<span class='pill idle'>off</span> This device does not get alerts yet.";
        on.hidden = false; test.hidden = true; off.hidden = true;
      }
    }
  }
  function pushSay(btn, html) { var p = btn.closest("[data-push-panel]"); var st = p && p.querySelector("[data-push-state]"); if (st) st.innerHTML = html; }
  document.addEventListener("click", async function (e) {
    var on = e.target.closest("[data-push-on]"), test = e.target.closest("[data-push-test]"), off = e.target.closest("[data-push-off]");
    if (!on && !test && !off) return;
    var btn = on || test || off;
    btn.disabled = true;
    try {
      if (on) {
        var perm = await Notification.requestPermission();
        if (perm !== "granted") throw new Error("Notifications were not allowed.");
        var reg = await swReady();
        var vapid = btn.closest("[data-push-panel]").getAttribute("data-vapid");
        var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapid) });
        var j = sub.toJSON();
        var r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, label: deviceLabel() }) });
        if (!r.ok) throw new Error((await r.json().catch(function () { return {}; })).error || ("Failed (" + r.status + ")"));
        await renderPush();
        test = btn.closest("[data-push-panel]").querySelector("[data-push-test]");
        pushSay(btn, "<span class='pill up'>on</span> Alerts are on. Sending a test…");
      }
      if (test) {
        var t = await (await fetch("/api/push/test", { method: "POST" })).json();
        pushSay(btn, t.ok ? "<span class='pill up'>on</span> Test sent to " + t.phones + " device" + (t.phones === 1 ? "" : "s") + ". It should arrive in a few seconds." : "<span class='pill down'>failed</span> " + (t.error || "The test did not send."));
      }
      if (off) {
        var s2 = await (await swReady()).pushManager.getSubscription();
        if (s2) {
          await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: s2.endpoint }) });
          await s2.unsubscribe();
        }
        await renderPush();
      }
    } catch (err) {
      pushSay(btn, "<span class='pill down'>not on</span> " + err.message);
    } finally {
      btn.disabled = false;
    }
  });
  document.addEventListener("DOMContentLoaded", function () { renderPush(); });
  document.addEventListener("htmx:afterSwap", function (e) { renderPush(e.target); });
  setTimeout(renderPush, 0);

  // ── Firewall rule form: the address box appears for "An address or network…" ─
  function syncCidr(root) {
    (root || document).querySelectorAll("[data-end-select]").forEach(function (sel) {
      var box = sel.parentElement.querySelector("[data-cidr-for]");
      if (box) box.hidden = sel.value !== "cidr";
    });
  }
  document.addEventListener("change", function (e) { if (e.target.matches && e.target.matches("[data-end-select]")) syncCidr(e.target.parentElement); });
  document.addEventListener("htmx:afterSwap", function (e) { syncCidr(e.target); });
  syncCidr();

  // ── Confirmation word gate ──────────────────────────────────────────────
  // A button marked data-hard-disabled (e.g. GitHub is not connected) stays
  // off whatever is typed.
  function wireConfirm(root) {
    (root || document).querySelectorAll("[data-confirm-word]").forEach(function (input) {
      var word = input.getAttribute("data-confirm-word");
      var btn = input.form && input.form.querySelector("button[type=submit]");
      if (!btn) return;
      var update = function () { btn.disabled = btn.hasAttribute("data-hard-disabled") || input.value.trim().toLowerCase() !== word; };
      input.addEventListener("input", update);
      update();
    });
  }
  wireConfirm();
  document.addEventListener("htmx:afterSwap", function (e) { wireConfirm(e.target); });

  // ── "Are you sure?" on plain forms ──────────────────────────────────────
  // A form with data-confirm="question" asks before it sends. (htmx forms use
  // hx-confirm; this is for the ordinary ones, such as the Settings removals.)
  // Capture phase, so a "no" stops the form before anything else sees it.
  document.addEventListener("submit", function (e) {
    var f = e.target;
    var q = f && f.getAttribute && f.getAttribute("data-confirm");
    if (q && !window.confirm(q)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ── Secret reveal (the SSH password panel) ─────────────────────────────
  // The password is not in the page: Show and Copy fetch it from the
  // dashboard when pressed, and Hide (or closing the panel) forgets it. So
  // it is never in the 20-second refreshes or anything the browser keeps.
  function fetchSecret(el) {
    return fetch(el.getAttribute("data-secret"), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.password) throw new Error(j.error || "Could not fetch the password (" + r.status + ")."); return j.password; }); });
  }
  function hideSecret(row) {
    if (!row) return;
    var val = row.querySelector("[data-secret]"), mask = row.querySelector(".secret-mask"), r = row.querySelector("[data-reveal]");
    if (val) { val.textContent = ""; val.hidden = true; }
    if (mask) mask.hidden = false;
    if (r) r.textContent = "Show";
  }
  document.addEventListener("click", function (e) {
    var r = e.target.closest("[data-reveal]");
    var c = e.target.closest("[data-copy-secret]");
    if (!r && !c) return;
    var row = (r || c).closest("tr");
    var val = row.querySelector("[data-secret]");
    var mask = row.querySelector(".secret-mask");
    var b = r || c;
    if (r && !val.hidden) { hideSecret(row); return; }
    b.disabled = true;
    fetchSecret(val).then(function (pw) {
      if (r) {
        val.textContent = pw; val.hidden = false; mask.hidden = true;
        r.textContent = "Hide";
        return;
      }
      return navigator.clipboard.writeText(pw).then(function () {
        var old = c.textContent; c.textContent = "Copied"; setTimeout(function () { c.textContent = old; }, 1200);
      });
    }).catch(function (err) { alert(err.message); }).finally(function () { b.disabled = false; });
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
    var done = reveal.querySelector("[data-reveal-close]");
    if (done && done.offsetParent !== null) done.focus({ preventScroll: true });
    if (window.htmx) htmx.ajax("GET", "/partials/peers-table", { target: "#peers-table", swap: "outerHTML" });
  }

  // Done on the new-config panel: wipe the key, the QR and the download link
  // from the page, not just hide them.
  function closeReveal() {
    var reveal = document.getElementById("peer-reveal");
    if (!reveal) return;
    reveal.hidden = true;
    var conf = reveal.querySelector("#peer-conf"); if (conf) conf.textContent = "";
    var qr = reveal.querySelector(".qr"); if (qr) qr.innerHTML = "";
    var dl = reveal.querySelector("[data-download]");
    if (dl) {
      if (dl.href && dl.href.indexOf("blob:") === 0) URL.revokeObjectURL(dl.href);
      dl.setAttribute("href", "#"); dl.removeAttribute("download");
    }
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
