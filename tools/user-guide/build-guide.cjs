// Copies the screenshots the guide references into docs/user-guide, renders the markdown to
// HTML and prints it to docs/USER_GUIDE.pdf with headless Chrome.
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "../..").replace(/\\/g, "/");
const md = path.join(repo, "docs/USER_GUIDE.md");
const imgDir = path.join(repo, "docs/user-guide");
const shots = path.join(__dirname, "shots");
fs.mkdirSync(imgDir, { recursive: true });

const src = fs.readFileSync(md, "utf8");
const refs = [...src.matchAll(/\]\(user-guide\/([^)]+)\)/g)].map((m) => m[1]);
const missing = [];
for (const f of new Set(refs)) {
  const from = path.join(shots, f);
  if (!fs.existsSync(from)) {
    missing.push(f);
    continue;
  }
  fs.copyFileSync(from, path.join(imgDir, f));
}
console.log(`images: ${new Set(refs).size} referenced, ${missing.length} missing`, missing);

// Markdown -> HTML via marked (npx cache) with a print stylesheet.
const body = execSync(`npx --yes marked --gfm -i "${md}"`, { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString();
const css = `
body{font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111;max-width:900px;margin:0 auto;padding:24px}
h1{font-size:24pt;margin-bottom:4px}h2{font-size:16pt;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;page-break-after:avoid}
h3{font-size:12.5pt;margin-top:20px;page-break-after:avoid}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:9.5pt}th,td{border:1px solid #bbb;padding:5px 7px;vertical-align:top;text-align:left}th{background:#f2f2f2}
code{font-family:Consolas,Menlo,monospace;font-size:9.5pt;background:#f4f4f4;padding:1px 3px;border-radius:3px}
pre{background:#f4f4f4;padding:10px;border-radius:4px;overflow-x:auto;font-size:9pt;white-space:pre-wrap}pre code{background:none;padding:0}
li{margin:2px 0}
img{max-width:100%;height:auto;border:1px solid #d5d5d5;border-radius:4px;margin:8px 0 14px;page-break-inside:avoid;display:block}
p:has(> img){text-align:center}
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Outreach Engine user guide</title><base href="file:///${repo}/docs/"><style>${css}</style></head><body>${body}</body></html>`;
const htmlPath = path.join(__dirname, "user-guide.html");
fs.writeFileSync(htmlPath, html);

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pdf = path.join(repo, "docs/USER_GUIDE.pdf");
execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, `file:///${htmlPath.replace(/\\/g, "/")}`], { stdio: "ignore" });
console.log("pdf", pdf, fs.statSync(pdf).size, "bytes");
