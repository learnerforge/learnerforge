"use strict"

/**
 * generate-snake.js
 *
 * Reimplements the Platane/snk animated contribution snake as a self-contained,
 * dependency-free Node script. Pure CSS animation (no JS, no SMIL) so it runs
 * anywhere an <img> can render an SVG — including GitHub's Camo proxy.
 *
 * Mechanics (reverse-engineered from the real snk output):
 *  - The grid starts fully colored with contribution cells.
 *  - The snake head crawls cell to cell along a solver-computed path
 *    (greedy "eat the closest unvisited cell").
 *  - Each colored cell has a CSS keyframe that returns it to the empty color
 *    at the exact percentage the head arrives: that is the "eating".
 *  - The snake is 4 rounded rects (head + trailing body). Each has a
 *    transform:translate() keyframe per path cell, so the body trails by
 *    one cell per segment.
 *  - A progress bar (transform:scale(0,1)) fills as columns are cleared.
 *
 * Usage:
 *   node scripts/generate-snake.js [username] [output]
 */

const fs = require("fs")
const path = require("path")

const USER = process.argv[2] || "learnerforge"
const OUT = process.argv[3] || path.join("assets", "github-contribution-grid-snake-dark.svg")

// Offline fallback grid: 53 columns x 7 rows of contribution levels (0-4),
// captured from the repo's original static snake asset.
const FALLBACK_GRID = [
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
  [1,0,0,1,0,1,1],[0,0,0,1,1,1,0],[0,0,0,0,1,0,2],[2,1,1,1,1,0,1],[1,0,0,1,1,1,1],
  [1,1,1,1,0,0,0],[0,0,0,1,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,1,1],[1,1,2,1,1,2,1],
  [0,0,4,2,0,2,2],[0,4,2,0,0,0,0],
]
const FALLBACK_TOTAL = 230

// ---- theme (dark-luxury purple) ------------------------------------------
const THEME = {
  bg: "#0D0B1A",
  ce: "#1B1630", // empty cell
  c1: "#2B1B4E",
  c2: "#5B21B6",
  c3: "#8B5CF6",
  c4: "#C4B5FD",
  cs: "#8B5CF6", // snake base color
  body: ["#8B5CF6", "#7C3AED", "#6D28D9", "#5B21B6"], // head is gradient
  gridX0: 44,
  gridY0: 78,
  cell: 11, // rect size
  step: 14, // cell pitch
  msPerCell: 200, // travel time for one cell
  delta: 0.02, // hold width (%) around an event, like snk
}

// ---- data ------------------------------------------------------------------

async function fetchContributions(user) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(user)}/contributions`, {
    headers: { "User-Agent": "learnerforge-snake-generator/1.0" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()

  // GitHub renders the calendar one <td> per day, row-major (Sunday-first),
  // with attributes in this order: data-ix, data-date, data-level.
  const cells = [...html.matchAll(/<td[^>]*data-ix="(\d+)"[^>]*data-date="([\d-]+)"[^>]*data-level="([0-4])"[^>]*>/g)]
  if (cells.length < 7) throw new Error("contribution grid not found")

  const grid = []
  const ncols = Math.max(...cells.map((m) => Number(m[1]))) + 1
  const dow = (date) => new Date(date + "T00:00:00Z").getUTCDay()
  for (let c = 0; c < ncols; c++) {
    grid.push([])
    for (let r = 0; r < 7; r++) grid[c].push(0)
  }
  for (const m of cells) {
    const col = Number(m[1])
    const row = dow(m[2])
    if (col < ncols && row >= 0 && row < 7) grid[col][row] = Number(m[3])
  }

  // total contributions come from the per-day tooltips
  const total = [...html.matchAll(/(\d+)\s+contributions?\s+on\s+[A-Z]/g)]
    .reduce((sum, m) => sum + Number(m[1]), 0)

  return { grid, total }
}

// ---- path solver ------------------------------------------------------------

function solvePath(cols, rows) {
  const unvisited = new Set()
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) unvisited.add(`${c},${r}`)

  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
  const stepCounts = [] // cumulative cells travelled, one entry per eaten cell
  let cur = [0, -1] // start above the grid, column 0
  let steps = 0
  const order = []

  while (unvisited.size) {
    let best = null
    let bestD = Infinity
    for (const key of unvisited) {
      const [c, r] = key.split(",").map(Number)
      const d = dist(cur, [c, r])
      if (d < bestD) {
        bestD = d
        best = [c, r]
      } else if (d === bestD && best) {
        // tie-break: prefer the cell that continues the last direction
        const dx = c - cur[0]
        const dy = r - cur[1]
        if (Math.abs(dx) > Math.abs(dy)) best = [c, r]
      }
    }
    steps += bestD
    cur = best
    unvisited.delete(`${best[0]},${best[1]}`)
    order.push(best)
    stepCounts.push(steps)
  }

  // return off-grid at the end
  const ret = [0, -1]
  steps += dist(cur, ret)
  return { order, stepCounts, totalSteps: steps }
}

// ---- generation -------------------------------------------------------------

function fmt(x) {
  return x.toFixed(2)
}

function build({ grid, total }, theme) {
  const rows = 7
  const cols = grid.length
  const { order, stepCounts, totalSteps } = solvePath(cols, rows)

  const totalMs = Math.max(1000, Math.round((totalSteps * theme.msPerCell) / 10) * 10)
  const pct = (cellsTravelled) => (cellsTravelled / totalSteps) * 100

  const cx = (c) => theme.gridX0 + c * theme.step
  const cy = (r) => theme.gridY0 + r * theme.step
  const start = [cx(0), cy(-1)] // above the grid, column 0

  // arrival times for each eaten cell (strictly increasing: stepCounts grows
  // by >=1 each move, so no two cells can share a rounded keyframe time)
  const arrival = order.map((_, i) => pct(stepCounts[i]))
  const arrivalAt = {}
  for (let i = 0; i < order.length; i++) arrivalAt[`${order[i][0]},${order[i][1]}`] = arrival[i]

  // ---- per-cell eating keyframes ----
  let cellRules = ""
  let cellKeyframes = ""
  let k = 0
  const cellClasses = []
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const level = grid[c][r]
      if (level < 1 || level > 4) {
        cellClasses.push(`<rect class="c" x="${cx(c)}" y="${cy(r)}" width="${theme.cell}" height="${theme.cell}" rx="2.5"/>`)
        continue
      }
      const t = arrivalAt[`${c},${r}`]
      const t2 = Math.min(100, t + theme.delta)
      const color = `var(--c${level})`
      cellClasses.push(
        `<rect class="c c${k}" x="${cx(c)}" y="${cy(r)}" width="${theme.cell}" height="${theme.cell}" rx="2.5"/>`
      )
      cellRules += `.c.c${k}{fill:${color};animation-name:c${k}}`
      cellKeyframes += `@keyframes c${k}{${fmt(t)}%{fill:${color}}${fmt(t2)}%,100%{fill:var(--ce)}}`
      k++
    }
  }

  // ---- snake segments ----
  const segKeyframes = []
  const segSizes = [
    { w: 14.4, rx: 4.5 },
    { w: 12.3, rx: 4.1 },
    { w: 10.8, rx: 3.6 },
    { w: 9.9, rx: 3.3 },
  ]

  const cellStepPct = (theme.msPerCell / totalMs) * 100

  // head trajectory: off-grid start -> eaten cells -> crawl back to start
  // (the return is emitted as real waypoints so the whole body crawls back
  // instead of gliding across the grid)
  const lastCell = order[order.length - 1]
  const returnPath = []
  {
    let [rc, rr] = [lastCell[0], lastCell[1]]
    while (rc > 0) returnPath.push([--rc, rr])
    while (rr > -1) returnPath.push([rc, --rr])
  }
  const retTimes = returnPath.map((_, i) => arrival[arrival.length - 1] + (i + 1) * cellStepPct)
  const headTimes = [0, ...arrival, ...retTimes, 100]
  const headPos = [
    start,
    ...order.map(([c, r]) => [cx(c), cy(r)]),
    ...returnPath.map(([c, r]) => [cx(c), cy(r)]),
    start,
  ]

  for (let sIdx = 0; sIdx < 4; sIdx++) {
    // body segment k is one cell behind the head
    const behind = sIdx
    const times = headTimes.slice()
    const positions = headPos.map((_, i) => {
      const j = Math.max(0, i - behind)
      return headPos[j]
    })
    const rules = []
    for (let i = 0; i < times.length; i++) {
      rules.push(`${fmt(times[i])}%{transform:translate(${positions[i][0]}px,${positions[i][1]}px)}`)
    }
    // merge adjacent identical-position rules (shared percentage lists, like snk)
    const merged = []
    for (const rule of rules) {
      const [t, rest] = [rule.slice(0, rule.indexOf("%")), rule.slice(rule.indexOf("%") + 1)]
      if (merged.length && merged[merged.length - 1].pos === rest) merged[merged.length - 1].t.push(t)
      else merged.push({ t: [t], pos: rest })
    }
    const key = merged.map((m) => `${m.t.join(",")}%${m.pos}`).join("")
    segKeyframes.push({ name: `s${sIdx}`, body: key, size: segSizes[sIdx] })
  }

  // ---- progress bar (one segment, fills as columns are cleared) ----
  const clearTimes = []
  for (let c = 0; c < cols; c++) {
    let maxT = 0
    for (let r = 0; r < rows; r++) {
      const level = grid[c][r]
      if (level >= 1 && level <= 4) maxT = Math.max(maxT, arrivalAt[`${c},${r}`] || 0)
    }
    clearTimes.push({ col: c, t: maxT })
  }
  clearTimes.sort((a, b) => a.t - b.t)
  let done = 0
  const trailRules = []
  for (const ct of clearTimes) {
    done++
    const sc = (done / cols).toFixed(3)
    const t = fmt(ct.t)
    const t2 = fmt(Math.min(100, ct.t + theme.delta))
    trailRules.push(`${t}%{transform:scale(${sc},1)}${t2}%{transform:scale(${sc},1)}`)
  }
  const trailKeyframes = `@keyframes u0{${trailRules.join("")}}`

  // ---- svg ----
  const gridRight = cx(cols - 1) + theme.cell
  const svgW = gridRight + 47
  const svgH = 220
  const trailW = gridRight - theme.gridX0

  const style = `
:root{--ce:${THEME.ce};--c1:${THEME.c1};--c2:${THEME.c2};--c3:${THEME.c3};--c4:${THEME.c4};--cs:${THEME.cs};--cb:${THEME.ce}}
.c{shape-rendering:geometricPrecision;fill:var(--ce);stroke-width:1px;stroke:var(--cb);animation:none ${totalMs}ms linear infinite}
${cellRules}
${cellKeyframes}
.s{shape-rendering:geometricPrecision;animation:none ${totalMs}ms linear infinite}
${segKeyframes.map((s) => `.s.s${s.name}{animation-name:${s.name}}`).join("")}
@keyframes s0{${segKeyframes[0].body}}
@keyframes s1{${segKeyframes[1].body}}
@keyframes s2{${segKeyframes[2].body}}
@keyframes s3{${segKeyframes[3].body}}
.u{transform-origin:0 0;transform:scale(0,1);animation:none ${totalMs}ms linear infinite}
.u.u0{fill:var(--cs);animation-name:u0}
${trailKeyframes}
`

  const snakeGroups = segKeyframes
    .map((s, i) => {
      const fill = i === 0 ? `fill="url(#snakeGrad)"` : `fill="${THEME.body[i]}"`
      const eye = i === 0 ? `<circle cx="4" cy="4" r="1.8" fill="#E4B53A"/><circle cx="4" cy="4" r="0.9" fill="#0D0B1A"/>` : ""
      return `<g class="s s${i}"><rect x="-0.4" y="-0.4" width="${s.size.w}" height="${s.size.w}" rx="${s.size.rx}" ${fill}/>${eye}</g>`
    })
    .join("")

  const legend = `
<text x="708" y="207" font-family="'Segoe UI',sans-serif" font-size="11" fill="#6B648A" text-anchor="end">Less</text>
<rect x="716" y="198" width="11" height="11" rx="2.5" fill="${THEME.ce}"/>
<rect x="730" y="198" width="11" height="11" rx="2.5" fill="${THEME.c1}"/>
<rect x="744" y="198" width="11" height="11" rx="2.5" fill="${THEME.c2}"/>
<rect x="758" y="198" width="11" height="11" rx="2.5" fill="${THEME.c3}"/>
<rect x="772" y="198" width="11" height="11" rx="2.5" fill="${THEME.c4}"/>
<text x="794" y="207" font-family="'Segoe UI',sans-serif" font-size="11" fill="#6B648A">More</text>
`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="${USER} contribution graph with snake">
<defs><linearGradient id="snakeGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6D28D9"/><stop offset="0.6" stop-color="#8B5CF6"/><stop offset="1" stop-color="#C4B5FD"/></linearGradient></defs>
<style>${style.trim()}</style>
  <rect x="0" y="0" width="${svgW}" height="${svgH}" rx="18" fill="${THEME.bg}"/>
<g class="dots">${cellClasses.join("")}</g>
<g transform="translate(${THEME.gridX0} 188)"><rect class="u u0" x="0" y="0" width="${trailW}" height="10" rx="3"/></g>
<g class="snake">${snakeGroups}</g>
<text x="${svgW / 2}" y="40" font-family="'Segoe UI','Fira Code',sans-serif" font-size="17" font-weight="600" fill="#C9C2E8" text-anchor="middle">${total} contributions in the last year</text>
${legend}
</svg>
`
}

// ---- main -------------------------------------------------------------------

async function main() {
  let data
  try {
    data = await fetchContributions(USER)
    console.log(`fetched live grid from github.com/${USER}`)
  } catch (err) {
    console.log(`live fetch failed (${err.message}); using embedded fallback grid`)
    data = { grid: FALLBACK_GRID, total: FALLBACK_TOTAL }
  }

  const svg = build(data, THEME)
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, svg)
  console.log(`wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KiB, ${data.grid.length} columns)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
