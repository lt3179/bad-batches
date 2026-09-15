/*
  Regenerates us-states-paths.json from us-atlas's topology-correct state
  boundaries (Albers USA projection, shared borders between neighbors).

  This is a one-off/maintenance script, not part of the runtime pipeline.
  Run it only if you want to regenerate the map shapes (e.g. picking up an
  updated us-atlas release). Needs: npm install us-atlas topojson-client
  d3-geo (see package.json in this folder).

  Usage: node scripts/build_state_paths.js > us-states-paths.json
*/

const topojson = require("topojson-client");
const d3geo = require("d3-geo");
const topo = require("us-atlas/states-albers-10m.json");

const FIPS_TO_ABBR = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
  "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY",
};

const geo = topojson.feature(topo, topo.objects.states);
// Coordinates in this file are already projected (Albers USA), so use an
// identity path generator, no projection function, just format the geometry.
const path = d3geo.geoPath();

const states = {};
for (const f of geo.features) {
  const abbr = FIPS_TO_ABBR[f.id];
  if (!abbr) {
    console.error("no postal abbreviation mapped for FIPS", f.id);
    continue;
  }
  states[abbr] = { d: path(f), name: f.properties.name };
}

const [x0, y0, x1, y1] = topo.bbox;
const pad = 10;
const viewBox = [
  Math.floor(x0 - pad),
  Math.floor(y0 - pad),
  Math.ceil(x1 - x0 + 2 * pad),
  Math.ceil(y1 - y0 + 2 * pad),
].join(" ");

process.stdout.write(JSON.stringify({ viewBox, states }));
