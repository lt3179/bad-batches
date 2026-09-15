/*
  Frontend for the recall map. Everything here is display logic: reading
  the already-normalized data/recalls.json (built by scripts/fetch_recalls.py)
  and rendering it. No parsing or interpretation of raw agency text happens
  in this file.
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
  3: "#B3261E", // Class I
  2: "#C97A1B", // Class II
  1: "#3E6FA8", // Class III
  0: "#C9CBC2", // no recalls in window
};

let state = {
  recalls: [],
  window: "60", // "60" or "all"
  showRegions: false,
  selectedState: null,
  geoLayer: null,
  stateAbbrToLayer: {},
};

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------

async function loadData() {
  const [geoRes, recallRes] = await Promise.all([
    fetch("us-states.json"),
    fetch("data/recalls.json"),
  ]);
  const geo = await geoRes.json();
  const recallData = await recallRes.json();

  state.recalls = recallData.recalls || [];
  const generated = recallData.generated_at;
  document.getElementById("last-updated").textContent = generated
    ? `Updated ${generated}, ${recallData.count} recalls tracked`
    : "Recall data unavailable";

  return geo;
}

function normalizeDateString(raw) {
  if (!raw) return null;
  // Handles both FDA's YYYYMMDD and FSIS's likely YYYY-MM-DD.
  const digits = String(raw).replace(/-/g, "");
  if (digits.length !== 8) return null;
  const y = digits.slice(0, 4), m = digits.slice(4, 6), d = digits.slice(6, 8);
  return new Date(`${y}-${m}-${d}T00:00:00`);
}

function recallsInWindow() {
  if (state.window === "all") return state.recalls;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  return state.recalls.filter((r) => {
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
  const recalls = recallsForState(abbr);
  let worst = 0;
  for (const r of recalls) {
    const rank = SEVERITY_RANK[r.classification] || 0;
    if (rank > worst) worst = rank;
  }
  return worst;
}

// ---------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------

function styleForFeature(feature) {
  const abbr = feature.id;
  if (state.showRegions) {
    const region = CENSUS_REGION[abbr];
    return {
      fillColor: SEVERITY_COLOR[worstSeverityForState(abbr)],
      fillOpacity: 0.85,
      color: REGION_COLOR[region] || "#999",
      weight: 2.5,
    };
  }
  return {
    fillColor: SEVERITY_COLOR[worstSeverityForState(abbr)],
    fillOpacity: 0.85,
    color: "#FFFFFF",
    weight: 1,
  };
}

function refreshMapStyles() {
  if (!state.geoLayer) return;
  state.geoLayer.eachLayer((layer) => {
    layer.setStyle(styleForFeature(layer.feature));
    if (layer.feature.id === state.selectedState) {
      layer.setStyle({ weight: 3, color: "#1B211E" });
    }
  });
}

function initMap(geo) {
  const map = L.map("map", {
    zoomControl: true,
    minZoom: 3,
    maxZoom: 6,
  }).setView([39.5, -98.35], 4);

  L.control.zoom({ position: "topright" }).addTo(map);

  state.geoLayer = L.geoJSON(geo, {
    style: styleForFeature,
    onEachFeature: (feature, layer) => {
      state.stateAbbrToLayer[feature.id] = layer;
      layer.on("mouseover", () => layer.setStyle({ weight: 2.5 }));
      layer.on("mouseout", () => refreshMapStyles());
      layer.on("click", () => selectState(feature.id, feature.properties.name));
      layer.bindTooltip(feature.properties.name, { sticky: true });
    },
  }).addTo(map);

  map.fitBounds(state.geoLayer.getBounds());
}

// ---------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------

function selectState(abbr, name) {
  state.selectedState = abbr;
  refreshMapStyles();

  const recalls = recallsForState(abbr);
  document.getElementById("detail-empty").hidden = true;
  const content = document.getElementById("detail-content");
  content.hidden = false;

  document.getElementById("detail-state-name").textContent = name;
  document.getElementById("detail-count").textContent =
    recalls.length === 0
      ? "No recalls in the selected window."
      : `${recalls.length} recall${recalls.length === 1 ? "" : "s"} in the selected window`;

  const list = document.getElementById("recall-list");
  list.innerHTML = "";
  recalls
    .sort((a, b) => (b.recall_date || "").localeCompare(a.recall_date || ""))
    .forEach((r) => {
      const li = document.createElement("li");
      const classNum = SEVERITY_RANK[r.classification] || 0;
      li.className = `recall-card class-${classNum}`;
      li.innerHTML = `
        <p class="recall-card-title">${escapeHtml(r.title || "Untitled recall")}</p>
        <p class="recall-card-meta">${escapeHtml(r.firm || "")}${r.firm ? " &middot; " : ""}${escapeHtml(r.classification || "Unclassified")} &middot; ${formatDate(r.recall_date)}</p>
      `;
      li.addEventListener("click", () => openModal(r));
      list.appendChild(li);
    });
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
// Modal ("same batch" view)
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

  const linkRow = document.createElement("div");
  if (recall.url) {
    const a = document.createElement("a");
    a.href = recall.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "View official recall notice";
    linkRow.appendChild(a);
    fields.appendChild(linkRow);
  }

  document.getElementById("recall-modal").hidden = false;
}

function closeModal() {
  document.getElementById("recall-modal").hidden = true;
}

// ---------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------

function initToolbar() {
  document.querySelectorAll("[data-window]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-window]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.window = btn.dataset.window;
      refreshMapStyles();
      if (state.selectedState) {
        const name = state.stateAbbrToLayer[state.selectedState]?.feature?.properties?.name;
        selectState(state.selectedState, name);
      }
    });
  });

  document.getElementById("region-toggle").addEventListener("change", (e) => {
    state.showRegions = e.target.checked;
    refreshMapStyles();
  });

  document.getElementById("recall-modal-close").addEventListener("click", closeModal);
  document.getElementById("recall-modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

// ---------------------------------------------------------------------

(async function main() {
  initToolbar();
  const geo = await loadData();
  initMap(geo);
})();
