const fs = require("fs");
const path = require("path");
const https = require("https");

const ACTIVITY_FILE = path.join(__dirname, "..", "activity.json");
const README_FILE = path.join(__dirname, "..", "README.md");
const USERNAME = "learnerforge";

function fetch(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "learnerforge-activity-updater",
        Accept: "application/vnd.github.v3+json",
      },
    };
    https
      .get(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error(`GitHub returned invalid JSON (HTTP ${res.statusCode})`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub request failed (HTTP ${res.statusCode}): ${parsed.message || "unknown error"}`));
            return;
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      })
      .on("error", reject);
  });
}

async function getRecentActivity() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [eventsRes, reposRes] = await Promise.all([
    fetch(`https://api.github.com/users/${USERNAME}/events?per_page=100`),
    fetch(`https://api.github.com/users/${USERNAME}/repos?sort=updated&per_page=5`),
  ]);

  const events = (eventsRes.data || []).filter((event) => new Date(event.created_at) > new Date(since));
  const repos = reposRes.data || [];

  const commits = events
    .filter((e) => e.type === "PushEvent")
    .reduce((sum, e) => sum + (e.payload.commits?.length || 0), 0);

  const prs = events.filter((e) => e.type === "PullRequestEvent").length;
  const issues = events.filter((e) => e.type === "IssuesEvent").length;

  const recentRepos = repos
    .filter((r) => new Date(r.updated_at) > new Date(since))
    .slice(0, 3)
    .map((r) => ({ name: r.name, stars: r.stargazers_count, url: r.html_url }));

  return { commits, prs, issues, recentRepos };
}

function generateSection(activity, stats) {
  const lines = [];
  lines.push("## Live Activity");
  lines.push("");

  if (activity.focus_roles?.length) {
    lines.push("**Target Roles**");
    lines.push("");
    lines.push("<p align=\"center\">");
    activity.focus_roles.forEach((role) => {
      lines.push(`  <img src="https://img.shields.io/badge/${encodeURIComponent(role)}-7C3AED?style=for-the-badge&logo=target&logoColor=white" alt="${role}" />`);
    });
    lines.push("</p>");
    lines.push("");
  }

  if (activity.learning?.length) {
    lines.push("**Currently Learning**");
    lines.push("");
    activity.learning.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }

  if (activity.building?.length) {
    lines.push("**Building**");
    lines.push("");
    activity.building.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }

  if (activity.exploring?.length) {
    lines.push("**Exploring**");
    lines.push("");
    activity.exploring.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }

  if (stats) {
    lines.push("**Recent GitHub Activity** *(last 7 days)*");
    lines.push("");
    lines.push("<p align=\"center\">");
    if (stats.commits > 0) lines.push(`  <img src="https://img.shields.io/badge/Commits-${stats.commits}-8B5CF6?style=flat-square&logo=git&logoColor=white" alt="${stats.commits} commits" />`);
    if (stats.prs > 0) lines.push(`  <img src="https://img.shields.io/badge/PRs-${stats.prs}-7C3AED?style=flat-square&logo=github&logoColor=white" alt="${stats.prs} PRs" />`);
    if (stats.issues > 0) lines.push(`  <img src="https://img.shields.io/badge/Issues-${stats.issues}-6D28D9?style=flat-square&logo=github&logoColor=white" alt="${stats.issues} issues" />`);
    if (stats.recentRepos.length) {
      stats.recentRepos.forEach((r) => {
        lines.push(`  <a href="${r.url}"><img src="https://img.shields.io/badge/${r.name}-${r.stars}%20stars-A78BFA?style=flat-square&logo=github&logoColor=white" alt="${r.name}" /></a>`);
      });
    }
    lines.push("</p>");
    lines.push("");
  }

  if (activity.open_to?.length) {
    lines.push("**Open To**");
    lines.push("");
    lines.push("<p align=\"center\">");
    activity.open_to.forEach((item) => {
      const color = ["AI / ML internships"].includes(item) ? "8B5CF6" :
                    ["Research collaborations"].includes(item) ? "7C3AED" :
                    ["Hackathon teams"].includes(item) ? "6D28D9" : "A78BFA";
      lines.push(`  <img src="https://img.shields.io/badge/${encodeURIComponent(item)}-${color}?style=flat-square" alt="${item}" />`);
    });
    lines.push("</p>");
    lines.push("");
  }

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  lines.push(`<p align="center"><i>Last updated: ${dateStr}</i></p>`);
  lines.push("");

  return lines.join("\n");
}

function updateReadme(newSection) {
  let readme = fs.readFileSync(README_FILE, "utf8");
  const marker = "<!-- LIVE_ACTIVITY_START -->";
  const endMarker = "<!-- LIVE_ACTIVITY_END -->";

  const startIdx = readme.indexOf(marker);
  const endIdx = readme.indexOf(endMarker);

  if ((startIdx === -1) !== (endIdx === -1) || (startIdx !== -1 && endIdx < startIdx)) {
    throw new Error("README live activity markers are missing or out of order");
  }

  const wrapped = `${marker}\n${newSection}\n${endMarker}`;

  if (startIdx !== -1 && endIdx !== -1) {
    readme = readme.slice(0, startIdx) + wrapped + readme.slice(endIdx + endMarker.length);
  } else {
    const insertAt = readme.indexOf("## Current Focus");
    if (insertAt !== -1) {
      readme = readme.slice(0, insertAt) + wrapped + "\n" + readme.slice(insertAt);
    } else {
      readme += "\n" + wrapped + "\n";
    }
  }

  fs.writeFileSync(README_FILE, readme);
  console.log("README updated with live activity section");
}

async function main() {
  try {
    const activity = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8"));
    let stats = null;
    try {
      stats = await getRecentActivity();
      console.log(`GitHub stats: ${stats.commits} commits, ${stats.prs} PRs, ${stats.issues} issues`);
    } catch (e) {
      console.log("Could not fetch GitHub stats:", e.message);
    }
    const section = generateSection(activity, stats);
    updateReadme(section);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

main();
