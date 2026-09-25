// Fills the demo database: settings, services, users, suppression, instructions, link page.
const { launch, login, api, ADMIN, OPERATOR, VIEWER } = require("./lib.cjs");

(async () => {
  const { browser, page } = await launch();
  await login(page, ADMIN);

  // Organisation settings
  const { settings } = await api(page, "GET", "/api/settings");
  await api(page, "PUT", "/api/settings", {
    ...settings,
    fromEmail: "vigneyabhatt@somvanshitechnologies.digital",
    fromName: "Vigneya Bhatt",
    replyTo: "",
    dailyCap: 300,
    maxSendRate: 2,
    defaultApprovalMode: "manual",
    webSearchEnabled: false,
    postalAddress: "Somvanshi Technologies, Pune, Maharashtra, India",
    landingPage: {
      ...settings.landingPage,
      headline: "A little about what we do",
      intro: "Somvanshi Technologies builds software for growing Indian businesses. Here is a quick look at the services we offer.",
      contactEmail: "hello@somvanshitechnologies.digital",
      showUnsubscribe: true,
      footerNote: "You are receiving this because we reached out about our services.",
    },
  });
  console.log("settings saved");

  // Services
  const services = [
    {
      name: "Custom Web Applications",
      description: "Design and build of bespoke web applications: customer portals, internal tools, dashboards and integrations, delivered by a dedicated team.",
      targetAudience: "Founders and technology leaders at growing companies who have outgrown spreadsheets and off-the-shelf tools.",
      valueProps: ["Fixed-scope sprints with a working release every two weeks", "Modern stack (React, Node, PostgreSQL) with full source handed over", "Ongoing support after launch"],
      proofPoints: ["Delivered a lab-report portal used by 200+ collection centres", "Cut order processing time by 60% for a D2C grocery brand"],
      url: "https://somvanshitechnologies.digital/services/web-applications",
      tags: ["web", "portal", "integration"],
    },
    {
      name: "Data Pipelines & Analytics",
      description: "Reliable data pipelines, warehouses and dashboards so teams see one version of the truth across sales, operations and finance.",
      targetAudience: "Operations and product leaders who make decisions from data spread across many systems.",
      valueProps: ["Automated daily reporting instead of manual spreadsheet work", "Alerts when numbers move unexpectedly", "Works with existing tools (Shopify, Tally, Zoho, Google Sheets)"],
      proofPoints: ["Built a dispatch analytics stack for a 450-truck fleet"],
      url: "https://somvanshitechnologies.digital/services/data",
      tags: ["data", "analytics"],
    },
    {
      name: "AI Automation",
      description: "Practical AI features inside existing workflows: document extraction, drafting, classification and assistants built on Claude.",
      targetAudience: "Teams with repetitive document or communication work.",
      valueProps: ["Starts with a two-week pilot on real data", "Human review built in from day one"],
      proofPoints: ["Automated subtitle generation for a 40-person media agency"],
      url: "https://somvanshitechnologies.digital/services/ai",
      tags: ["ai", "automation"],
    },
  ];
  for (const s of services) await api(page, "POST", "/api/services", s);
  console.log("services created");

  // Users
  const users = await api(page, "GET", "/api/users");
  const existing = new Set(users.items.map((u) => u.email));
  if (!existing.has(OPERATOR.email)) {
    await api(page, "POST", "/api/users", {
      email: OPERATOR.email,
      name: OPERATOR.name,
      password: OPERATOR.password,
      role: "operator",
      fromName: "Riya Sharma",
      fromEmail: "riya.sharma@somvanshitechnologies.digital",
      dashboardScope: "own",
    });
  }
  if (!existing.has(VIEWER.email)) {
    await api(page, "POST", "/api/users", { email: VIEWER.email, name: VIEWER.name, password: VIEWER.password, role: "viewer" });
  }
  console.log("users created");

  // Suppression list entry
  await api(page, "POST", "/api/suppressions", { email: "donotcontact@example.in", reason: "manual", note: "Asked us not to email on 2026-09-20" }).catch((e) => console.log("suppression:", e.message));

  // A campaign-specific instruction document (organisation level)
  await api(page, "POST", "/api/instructions", {
    kind: "signature", scope: "org",
    title: "Signature with phone",
    content: "Best regards,\nVigneya Bhatt\nSomvanshi Technologies | +91 98xxx xxxxx",
    isActive: false,
  }).catch((e) => console.log("instruction:", e.message));

  await browser.close();
  console.log("SETUP DONE");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
