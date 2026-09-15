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
const SEVERITY_COLOR = {
  3: "var(--class-1)",
  2: "var(--class-2)",
  1: "var(--class-3)",
  0: "var(--none)",
};

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

function worstSeverityForState(abbr) {
  let worst = 0;
  for (const r of recallsForState(abbr)) {
    const rank = SEVERITY_RANK[r.classification] || 0;
    if (rank > worst) worst = rank;
  }
  return worst;
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
  });

  refreshMapStyles();
}

function refreshMapStyles() {
  svg.querySelectorAll(".state-shape").forEach((el) => {
    const abbr = el.dataset.id;
    el.setAttribute("fill", SEVERITY_COLOR[worstSeverityForState(abbr)]);

    if (appState.showRegions) {
      el.setAttribute("stroke", REGION_COLOR[CENSUS_REGION[abbr]] || "#999");
      el.setAttribute("stroke-width", "2.5");
    } else {
      el.removeAttribute("stroke");
      el.removeAttribute("stroke-width");
    }

    el.classList.toggle("is-selected", abbr === appState.selectedState);
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
