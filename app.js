/*
  Frontend for the recall map. Everything here is display logic: reading
  the already-normalized data/recalls.json (built by scripts/fetch_recalls.py)
  and the pre-computed state shapes in us-states-paths.json, then rendering
  them. No parsing or interpretation of raw agency text happens in this file.

  The map is a plain SVG built from us-atlas's topology-correct state
  boundaries (see scripts/build_state_paths.js), not a map library. That's
  intentional: it's what lets the zoom/pan-toward-cursor behavior below work
  the way it does, which isn't something a standard map library's own
  zoom/pan controls are built for.
*/

const CENSUS_REGION = {
  CT: "Northeast", ME: "Northeast", MA: "Northeast", NH: "Northeast",
  RI: "Northeast", VT: "Northeast", NJ: "Northeast", NY: "Northeast", PA: "Northeast",
  IL: "Midwest", IN: "Midwest", MI: "Midwest", OH: "Midwest", WI: "Midwest",
  IA: "Midwest", KS: "Midwest", MN: "Midwest", MO: "Midwest", NE: "Midwest",
  ND: "Midwest", SD: "Midwest",
  DE: "South", FL: "South", GA: "South", MD: "South", NC: "South", SC: "South",
  VA: "South", DC: "South", WV: "South", AL: "South", KY: "South", MS: "South",
  TN: "South", AR: "South", LA: "South", OK: "South", TX: "South",
  AZ: "West", CO: "West", ID: "West", MT: "West", NV: "West", NM: "West",
  UT: "West", WY: "West", AK: "West", CA: "West", HI: "West", OR: "West", WA: "West",
};

const REGION_COLOR = {
  Northeast: "#7A5CC0",
  Midwest: "#3E6FA8",
  South: "#B3261E",
  West: "#1F5C54",
};

const SEVERITY_RANK = { "Class I": 3, "Class II": 2, "Class III": 1 };

// Full-saturation hex per severity, used as the "most urgent" end of the
// recency/status gradient below. Keep in sync with the --class-* vars in
// style.css if those ever change.
const SEVERITY_HEX = {
  3: [0xB3, 0x26, 0x1E],
  2: [0xD5, 0x96, 0x4D],
  1: [0x69, 0x8F, 0xBB],
};
const NONE_HEX = [0xD2, 0xD3, 0xCB];

// Fixed decay window for the recency gradient, independent of the
// 60-day/all-history toggle: a recall from 3 years ago in "all history"
// mode should still read as fully faded, not fully bright.
const RECENCY_WINDOW_DAYS = 60;

let appState = {
  recalls: [],
  window: "60", // "60" or "all"
  showRegions: false,
  selectedState: null,
  stateNames: {},
};

const svg = document.getElementById("map-svg");
const ns = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------

async function loadData() {
  const [pathsRes, recallRes] = await Promise.all([
    fetch("us-states-paths.json"),
    fetch("data/recalls.json"),
  ]);
  const pathsData = await pathsRes.json();
  const recallData = await recallRes.json();

  appState.recalls = recallData.recalls || [];
  const generated = recallData.generated_at;
  document.getElementById("last-updated").textContent = generated
    ? `Updated ${generated}, ${recallData.count} recalls tracked`
    : "Recall data unavailable";

  return pathsData;
}

function normalizeDateString(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/-/g, "");
  if (digits.length !== 8) return null;
  const y = digits.slice(0, 4), m = digits.slice(4, 6), d = digits.slice(6, 8);
  return new Date(`${y}-${m}-${d}T00:00:00`);
}

function recallsInWindow() {
  if (appState.window === "all") return appState.recalls;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  return appState.recalls.filter((r) => {
    const d = normalizeDateString(r.recall_date);
    return d && d >= cutoff;
  });
}

function recallsForState(abbr) {
  return recallsInWindow().filter(
    (r) => r.nationwide || (r.states || []).includes(abbr)
  );
}

// Returns up to n recalls touching this state, worst severity first and
// most recent first within a severity tier. Drives both the base fill
// (top[0]) and the two accent dots (top[1], top[2]).
function topRecallsForState(abbr, n = 3) {
  const list = recallsForState(abbr).slice();
  list.sort((a, b) => {
    const ra = SEVERITY_RANK[a.classification] || 0;
    const rb = SEVERITY_RANK[b.classification] || 0;
    if (rb !== ra) return rb - ra;
    const da = normalizeDateString(a.recall_date);
    const db = normalizeDateString(b.recall_date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return list.slice(0, n);
}

function lightenMix(rgb, t = 0.82) {
  return rgb.map((c) => Math.round(c + (255 - c) * t));
}

function lerpRGB(a, b, t) {
  return a.map((c, i) => Math.round(c + (b[i] - c) * t));
}

function toHex(rgb) {
  return "#" + rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
}

// Base fill color for a state: hue = worst severity touching it, shade =
// how recent that recall is and whether it's still Ongoing. A resolved
// Class I recall from 55 days ago fades toward pale red; a fresh, still-
// active one stays near full saturation. Floor of ~0.15 so nothing goes
// fully invisible.
function stateFillColor(abbr) {
  const top = topRecallsForState(abbr, 1)[0];
  if (!top) return toHex(NONE_HEX);
  const rank = SEVERITY_RANK[top.classification] || 0;
  if (!rank) return toHex(NONE_HEX);

  const full = SEVERITY_HEX[rank];
  const light = lightenMix(full);
  const d = normalizeDateString(top.recall_date);
  const days = d ? Math.max(0, (Date.now() - d.getTime()) / 86400000) : RECENCY_WINDOW_DAYS;
  const recency = Math.max(0, Math.min(1, 1 - days / RECENCY_WINDOW_DAYS));
  const statusFactor = top.status === "Ongoing" ? 1 : 0.55;
  const intensity = Math.max(0, Math.min(1, 0.15 + 0.85 * recency * statusFactor));

  return toHex(lerpRGB(light, full, intensity));
}

// ---------------------------------------------------------------------
// Corner accent placement (2nd/3rd most relevant recall per state)
// ---------------------------------------------------------------------
//
// State paths are straight-line polygons (M/L/Z only, no curves), often
// multiple subpaths per state (e.g. Michigan's two peninsulas, Hawaii's
// islands). We anchor accents to the largest subpolygon by area so dots
// don't land in a gap between landmasses, then nudge toward that
// subpolygon's centroid until they're confirmed inside it.

function parseSubpaths(d) {
  return d
    .split(/Z/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/^M/, "")
        .split("L")
        .map((pair) => pair.split(",").map(Number))
        .filter((p) => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1]))
    )
    .filter((pts) => pts.length >= 3);
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function polygonCentroid(pts) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const n = pts.length;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

function pointInPolygon([px, py], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function dominantSubpolygon(d) {
  const subs = parseSubpaths(d);
  if (subs.length === 0) return null;
  let best = subs[0];
  let bestArea = Math.abs(polygonArea(subs[0]));
  for (const s of subs.slice(1)) {
    const a = Math.abs(polygonArea(s));
    if (a > bestArea) {
      bestArea = a;
      best = s;
    }
  }
  return best;
}

// Returns { p1, p2, r } in state-path coordinates, or null if the path
// couldn't be parsed. p1/p2 are guaranteed inside the dominant subpolygon.
function computeAccentAnchors(d) {
  const poly = dominantSubpolygon(d);
  if (!poly) return null;

  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const w = maxx - minx, h = maxy - miny;
  const centroid = polygonCentroid(poly);
  const r = Math.max(3, Math.min(7, 0.12 * Math.min(w, h)));

  function nudgeInside(pt) {
    let p = pt.slice();
    let tries = 0;
    while (!pointInPolygon(p, poly) && tries < 12) {
      p = [p[0] + (centroid[0] - p[0]) * 0.25, p[1] + (centroid[1] - p[1]) * 0.25];
      tries++;
    }
    return p;
  }

  const p1 = nudgeInside([maxx - 0.16 * w, miny + 0.18 * h]);
  const p2 = nudgeInside([p1[0], p1[1] + r * 2.6]);
  return { p1, p2, r };
}

// ---------------------------------------------------------------------
// Map: build once, then just recolor on toggle changes
// ---------------------------------------------------------------------

function buildMap(pathsData) {
  svg.setAttribute("viewBox", pathsData.viewBox);
  Object.entries(pathsData.states).forEach(([abbr, info]) => {
    appState.stateNames[abbr] = info.name;

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", info.d);
    path.setAttribute("class", "state-shape");
    path.dataset.id = abbr;
    path.addEventListener("click", () => selectState(abbr));

    const title = document.createElementNS(ns, "title");
    title.textContent = info.name;
    path.appendChild(title);

    svg.appendChild(path);

    // Corner accent dots for the 2nd/3rd most relevant recall. Anchor
    // positions are fixed per state shape, so compute once here rather
    // than on every refresh.
    const anchors = computeAccentAnchors(info.d);
    [1, 2].forEach((tier) => {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("class", `accent-dot accent-${tier}`);
      dot.dataset.id = abbr;
      const pt = anchors ? (tier === 1 ? anchors.p1 : anchors.p2) : [0, 0];
      dot.setAttribute("cx", pt[0]);
      dot.setAttribute("cy", pt[1]);
      dot.setAttribute("r", anchors ? anchors.r * (tier === 1 ? 1 : 0.82) : 0);
      dot.setAttribute("opacity", "0");
      svg.appendChild(dot);
    });
  });

  refreshMapStyles();
}

function refreshMapStyles() {
  svg.querySelectorAll(".state-shape").forEach((el) => {
    const abbr = el.dataset.id;
    el.setAttribute("fill", stateFillColor(abbr));

    if (appState.showRegions) {
      el.setAttribute("stroke", REGION_COLOR[CENSUS_REGION[abbr]] || "#999");
      el.setAttribute("stroke-width", "2.5");
    } else {
      el.removeAttribute("stroke");
      el.removeAttribute("stroke-width");
    }

    el.classList.toggle("is-selected", abbr === appState.selectedState);

    const top3 = topRecallsForState(abbr, 3);
    [1, 2].forEach((tier) => {
      const dot = svg.querySelector(`circle.accent-${tier}[data-id="${abbr}"]`);
      if (!dot) return;
      const recall = top3[tier]; // tier 1 -> index 1 (2nd recall), tier 2 -> index 2 (3rd)
      if (!recall) {
        dot.setAttribute("opacity", "0");
        return;
      }
      const rank = SEVERITY_RANK[recall.classification] || 0;
      dot.setAttribute("fill", toHex(SEVERITY_HEX[rank] || NONE_HEX));
      dot.setAttribute("opacity", "1");
    });
  });
}

// ---------------------------------------------------------------------
// Default zoom, width squish, and cursor-follow panning
// ---------------------------------------------------------------------

const BASE_SCALE = 1.5 * 1.1 * 0.8;    // net of all the zoom tweaks so far
const WIDTH_SQUISH = 0.8 * 1.1 * 1.1;  // net of all the width tweaks so far
const PAN_EASE = 0.06 * 1.15;
const PAN_FRACTION = 0.5;              // pan distance as a fraction of viewport size

let targetPan = { x: 0, y: 0 };
let currentPan = { x: 0, y: 0 };

window.addEventListener("mousemove", (e) => {
  const nx = (e.clientX / window.innerWidth - 0.5) * 2;
  const ny = (e.clientY / window.innerHeight - 0.5) * 2;
  targetPan.x = -nx * window.innerWidth * PAN_FRACTION;
  targetPan.y = -ny * window.innerHeight * PAN_FRACTION;
});

function tickPan() {
  currentPan.x += (targetPan.x - currentPan.x) * PAN_EASE;
  currentPan.y += (targetPan.y - currentPan.y) * PAN_EASE;
  svg.style.transform = `scale(${(BASE_SCALE * WIDTH_SQUISH).toFixed(4)}, ${BASE_SCALE.toFixed(4)}) translate(${currentPan.x.toFixed(1)}px, ${currentPan.y.toFixed(1)}px)`;
  requestAnimationFrame(tickPan);
}

// ---------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------

function selectState(abbr) {
  appState.selectedState = abbr;
  refreshMapStyles();

  const recalls = recallsForState(abbr);
  document.getElementById("detail-card").classList.add("is-open");
  document.getElementById("detail-state-name").textContent = appState.stateNames[abbr] || abbr;
  document.getElementById("detail-count").textContent =
    recalls.length === 0
      ? "No recalls in the selected window."
      : `${recalls.length} recall${recalls.length === 1 ? "" : "s"} in the selected window`;

  const list = document.getElementById("recall-list");
  list.innerHTML = "";
  recalls
    .sort((a, b) => (b.recall_date || "").localeCompare(a.recall_date || ""))
    .forEach((r) => {
      const classNum = SEVERITY_RANK[r.classification] || 0;
      const card = document.createElement("div");
      card.className = `recall-card class-${classNum}`;
      card.innerHTML = `
        <p class="recall-card-title">${escapeHtml(r.title || "Untitled recall")}</p>
        <p class="recall-card-meta">${escapeHtml(r.firm || "")}${r.firm ? " &middot; " : ""}${escapeHtml(r.classification || "Unclassified")} &middot; ${formatDate(r.recall_date)}</p>
      `;
      card.addEventListener("click", () => openModal(r));
      list.appendChild(card);
    });
}

function closeDetailPanel() {
  document.getElementById("detail-card").classList.remove("is-open");
  appState.selectedState = null;
  refreshMapStyles();
}

function formatDate(raw) {
  const d = normalizeDateString(raw);
  if (!d) return "Date unknown";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// "Same batch" modal
// ---------------------------------------------------------------------

function openModal(recall) {
  document.getElementById("modal-source").textContent = recall.source;
  document.getElementById("modal-title").textContent = recall.title || "Untitled recall";

  const fields = document.getElementById("modal-fields");
  fields.innerHTML = "";
  const rows = [
    ["Firm", recall.firm],
    ["Reason", recall.reason],
    ["Classification", recall.classification],
    ["Status", recall.status],
    ["Date", formatDate(recall.recall_date)],
  ];
  rows.forEach(([label, value]) => {
    if (!value) return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    fields.appendChild(dt);
    fields.appendChild(dd);
  });

  if (recall.url) {
    const dt = document.createElement("dt");
    dt.textContent = "Source";
    const dd = document.createElement("dd");
    const a = document.createElement("a");
    a.href = recall.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Official recall notice";
    dd.appendChild(a);
    fields.appendChild(dt);
    fields.appendChild(dd);
  }

  const statesList = document.getElementById("modal-states-list");
  statesList.innerHTML = "";
  const states = recall.nationwide ? ["Nationwide"] : (recall.states || []);
  if (states.length === 0) {
    statesList.innerHTML = '<span class="state-chip">Distribution not confirmed for specific states</span>';
  } else {
    states.forEach((s) => {
      const chip = document.createElement("span");
      chip.className = "state-chip";
      chip.textContent = s;
      statesList.appendChild(chip);
    });
  }

  document.getElementById("recall-modal").hidden = false;
}

function closeModal() {
  document.getElementById("recall-modal").hidden = true;
}

// ---------------------------------------------------------------------
// Toolbar + keyboard shortcuts
// ---------------------------------------------------------------------

function initControls() {
  document.querySelectorAll("[data-window]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-window]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      appState.window = btn.dataset.window;
      refreshMapStyles();
      if (appState.selectedState) selectState(appState.selectedState);
    });
  });

  document.getElementById("region-toggle").addEventListener("change", (e) => {
    appState.showRegions = e.target.checked;
    refreshMapStyles();
  });

  document.getElementById("detail-close").addEventListener("click", closeDetailPanel);
  document.getElementById("recall-modal-close").addEventListener("click", closeModal);
  document.getElementById("recall-modal-backdrop").addEventListener("click", closeModal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    if ((e.key === "e" || e.key === "E") && document.getElementById("recall-modal").hidden) {
      closeDetailPanel();
    }
  });
}

// ---------------------------------------------------------------------

(async function main() {
  initControls();
  const pathsData = await loadData();
  buildMap(pathsData);
  tickPan();
})();
