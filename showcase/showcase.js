// showcase.js: the public showcase page (showcase/index.html) — the film list, the stage and the MSE player.
const FILMS = [
  { id: "00-hero", title: "cloudlabs, live", text: "One click deploys a WireGuard VPN on Azure while its pipeline and log stream by. Then live traffic, a new client and its QR code, a firewall rule reviewed and applied, a packet capture, SSH into the live kit, an Azure lab building itself, and a typed tear-down back to £0." },
  { id: "01-deploy-and-destroy", title: "Deploy and destroy", text: "Pick how long it runs, deploy, and watch every pipeline step and log line arrive. Tear down by typing destroy, and nothing is left running." },
  { id: "02-live-traffic-and-log", title: "Live traffic and log", text: "The traffic chart scrolling in real time, heartbeat and latency ticking, the deploy log streaming, every client's handshake." },
  { id: "03-add-a-client", title: "Add a client", text: "Name it, choose what goes through the tunnel and see the exact AllowedIPs, scan the QR code, and watch it come online." },
  { id: "04-firewall-access-rule", title: "Firewall access rule", text: "Hit counters climbing, a new rule drafted, the diff reviewed and applied, the VM confirming it, and the new rule counting hits." },
  { id: "05-packet-capture", title: "Packet capture", text: "A tcpdump filter typed in the dashboard runs on the VM, then the capture file is ready to download." },
  { id: "06-ssh-live-kit", title: "SSH into live kit", text: "Allow SSH from your address in one click, then a terminal session on the gateway: wg show, a ping across the tunnel, and a hop into a lab VM.", isNew: true },
  { id: "07-azure-labs", title: "Azure Labs", text: "Pick one of 43 hands-on labs for AZ-104, AZ-305 and AZ-700, deploy it, and watch the pipeline and log until it is running." },
  { id: "08-lab-diagrams", title: "Lab diagrams", text: "The lab's live diagram filling in as Azure creates each resource, full screen with animated traffic, and a pop-out window for a second screen." },
];
const base = (id) => "films/" + id + "/";
const fmt = (s) => { s = Math.round(s); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const manifests = {};
let current = 0;
let started = false;

// Plays a film from films/<id>/ (manifest.json + init.mp4 + chunk-NNN.m4s) through
// MediaSource / ManagedMediaSource, else the progressive 720p fallback.
async function playShowcase(video, dir, m) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS || !MS.isTypeSupported(m.mime)) { video.src = dir + m.fallback.file; return "fallback"; }
  const ms = new MS();
  if (window.ManagedMediaSource && MS === window.ManagedMediaSource) video.disableRemotePlayback = true;
  video.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
  const sb = ms.addSourceBuffer(m.mime);
  const append = (buf) => new Promise((resolve, reject) => {
    const done = () => { sb.removeEventListener("error", fail); resolve(); };
    const fail = () => { sb.removeEventListener("updateend", done); reject(new Error("appendBuffer failed")); };
    sb.addEventListener("updateend", done, { once: true });
    sb.addEventListener("error", fail, { once: true });
    sb.appendBuffer(buf);
  });
  try {
    const files = [m.init, ...m.chunks.map((c) => c.file)];
    let next = fetch(dir + files[0]).then((r) => r.arrayBuffer());
    for (let i = 0; i < files.length; i++) {
      if (video.dataset.stale) return "stopped";
      const buf = await next;
      if (i + 1 < files.length) next = fetch(dir + files[i + 1]).then((r) => r.arrayBuffer());
      await append(buf);
    }
    if (ms.readyState === "open") ms.endOfStream();
    return "mse";
  } catch (e) {
    if (video.dataset.stale) return "stopped";
    video.src = dir + m.fallback.file;
    return "fallback";
  }
}

async function manifest(id) {
  if (!manifests[id]) manifests[id] = fetch(base(id) + "manifest.json").then((r) => r.json());
  return manifests[id];
}

function show(i) {
  current = i;
  const f = FILMS[i];
  document.getElementById("nowTitle").textContent = f.title;
  document.getElementById("nowText").textContent = f.text;
  document.getElementById("playLabel").textContent = i === 0 ? "Play the film" : "Play this highlight";
  document.getElementById("back").hidden = i === 0;
  document.querySelectorAll(".card").forEach((c, j) => c.setAttribute("aria-current", j === i ? "true" : "false"));
  const screen = document.getElementById("screen");
  const old = screen.querySelector("video");
  if (old) { old.dataset.stale = "1"; old.pause(); old.removeAttribute("src"); old.load(); old.remove(); }
  const poster = document.getElementById("poster");
  poster.hidden = false;
  poster.src = base(f.id) + "poster.jpg";
  poster.alt = f.title + ", opening frame";
  document.getElementById("play").hidden = false;
  manifest(f.id).then((m) => {
    if (current === i) document.getElementById("nowMeta").textContent = fmt(m.duration) + " · " + m.width + "×" + m.height;
  }).catch(() => {});
}

async function start() {
  const f = FILMS[current];
  const screen = document.getElementById("screen");
  const btn = document.getElementById("play");
  btn.hidden = true;
  const v = document.createElement("video");
  v.controls = true; v.muted = true; v.playsInline = true; v.setAttribute("playsinline", "");
  v.poster = base(f.id) + "poster.jpg";
  v.setAttribute("aria-label", f.title);
  screen.appendChild(v);
  document.getElementById("poster").hidden = true;
  const note = document.createElement("div");
  note.className = "loading"; note.textContent = "Loading…";
  screen.appendChild(note);
  const clear = () => note.remove();
  v.addEventListener("playing", clear, { once: true });
  v.addEventListener("canplay", () => { v.play().catch(() => {}); }, { once: true });
  try {
    const m = await manifest(f.id);
    playShowcase(v, base(f.id), m);
  } catch (e) {
    note.textContent = "This film could not load. Reload the page to try again.";
  }
  started = true;
}

const grid = document.getElementById("grid");
FILMS.forEach((f, i) => {
  if (i === 0) return; // the main film plays on the stage; the grid holds the highlights
  const b = document.createElement("button");
  b.type = "button"; b.className = "card"; b.id = "film-" + f.id;
  b.innerHTML = '<div class="thumb"><img alt="" loading="lazy"><span class="len">–:––</span></div>' +
    '<div><strong></strong><span class="now">Selected</span></div><span class="d"></span>';
  if (f.isNew) { const n = document.createElement("span"); n.className = "new"; n.textContent = "New"; b.querySelector(".thumb").appendChild(n); }
  b.querySelector("img").src = base(f.id) + "poster.jpg";
  b.querySelector("strong").textContent = f.title;
  b.querySelector(".d").textContent = f.text;
  manifest(f.id).then((m) => { b.querySelector(".len").textContent = fmt(m.duration); }).catch(() => {});
  b.addEventListener("click", () => {
    show(i);
    start();
    document.getElementById("screen").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  });
  grid.appendChild(b);
});
document.getElementById("play").addEventListener("click", start);
document.getElementById("back").addEventListener("click", () => { show(0); start(); });
show(0);
