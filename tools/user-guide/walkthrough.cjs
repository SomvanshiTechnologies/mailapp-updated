// Login + new-campaign wizard screenshots, then starts the campaign so the worker produces drafts.
const path = require("path");
const { launch, login, api, shot, goto, field, ADMIN, BASE } = require("./lib.cjs");

(async () => {
  const { browser, page } = await launch();

  // Login page
  await goto(page, "/login");
  await page.fill("#email", ADMIN.email);
  await shot(page, "01-login", { fullPage: false });
  await page.fill("input[type=password]", ADMIN.password);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  // Wizard step 1: upload
  await goto(page, "/campaigns/new");
  await shot(page, "10-new-campaign-step1-empty", { fullPage: false });
  await page.setInputFiles("input[type=file]", path.join(__dirname, "sample-leads.xlsx"));
  await page.getByRole("button", { name: "Continue" }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("button:has-text('Continue')")?.disabled).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, "11-new-campaign-step1-preview");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: configure
  await field(page, "Campaign name").fill("Q4 outreach: Indian mid-market tech leaders");
  await field(page, "Description").fill("First touch to engineering and product leaders at growing Indian companies, pitching web, data and AI services.");
  await field(page, "Extra guidance for this campaign").fill("Mention that we are based in Pune and work in IST hours. Keep the first email under 110 words.");
  await page.waitForTimeout(300);
  await shot(page, "12-new-campaign-step2-configure");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: review & create
  await page.waitForTimeout(400);
  await shot(page, "13-new-campaign-step3-review");
  await page.getByRole("button", { name: /create campaign/i }).click();
  await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}/);
  await page.waitForLoadState("networkidle");
  const campaignId = page.url().split("/campaigns/")[1].split(/[?#]/)[0];
  console.log("campaign", campaignId);

  // Draft campaign detail: Edit + Start visible
  await shot(page, "14-campaign-draft-detail");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.waitForTimeout(400);
  await shot(page, "15-campaign-draft-edit-settings");
  await page.getByRole("button", { name: "Overview" }).click().catch(() => {});

  // Start
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForTimeout(300);
  await shot(page, "16-campaign-start-confirm", { fullPage: false });
  await page.getByRole("dialog").getByRole("button", { name: /^start/i }).click().catch(async () => {
    await page.getByRole("button", { name: /^start/i }).last().click();
  });
  await page.waitForTimeout(1500);
  await shot(page, "17-campaign-running");

  // A second campaign left in draft, created through the API, for the campaign list.
  const fs = require("fs");
  const form = {
    file: { name: "sample-leads.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: fs.readFileSync(path.join(__dirname, "sample-leads.xlsx")) },
    payload: JSON.stringify({ name: "Healthcare labs: diagnostics digitisation", description: "Draft. Waiting for the refreshed lead list.", approvalMode: "manual" }),
  };
  const res = await page.request.post(`${BASE}/api/campaigns`, { headers: { "X-Requested-With": "mailapp" }, multipart: form });
  console.log("second campaign", res.status());

  fs.writeFileSync(path.join(__dirname, "campaign-id.txt"), campaignId);
  await browser.close();
  console.log("WALKTHROUGH DONE");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
