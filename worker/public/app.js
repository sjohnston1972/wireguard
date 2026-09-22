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

  var form = document.getElementById("add-peer");
  if (form) {
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var status = document.getElementById("add-peer-status");
      var btn = form.querySelector("button[type=submit]");
      status.textContent = "Making keys…"; btn.disabled = true;
      try {
        var keys = await genKeypair();
        var fd = new FormData(form);
        var r = await fetch("/api/peers", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: fd.get("name"), public_key: keys.publicKey, full_tunnel: fd.get("full_tunnel") === "1" }),
        });
        var data = await r.json();
        if (!r.ok) throw new Error(data.error || ("Failed (" + r.status + ")"));
        var conf = data.template.replace("__CLIENT_PRIVATE_KEY__", keys.privateKey);
        var reveal = document.getElementById("peer-reveal");
        reveal.hidden = false;
        reveal.querySelector("[data-peer-name]").textContent = data.peer.name;
        reveal.querySelector("[data-peer-ip]").textContent = data.peer.ip;
        reveal.querySelector("#peer-conf").textContent = conf;
        drawQr(reveal.querySelector(".qr"), conf);
        var dl = reveal.querySelector("[data-download]");
        var blob = new Blob([conf], { type: "text/plain" });
        dl.href = URL.createObjectURL(blob);
        dl.download = data.peer.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() + ".conf";
        status.textContent = "";
        form.reset();
        reveal.scrollIntoView({ behavior: "smooth", block: "start" });
        if (window.htmx) htmx.ajax("GET", "/partials/peers-table", { target: "#peers-table", swap: "outerHTML" });
      } catch (err) {
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }
})();
