// Screenshots of every screen once the first campaign has drafts in the review queue.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { launch, login, api, shot, goto, field, ADMIN, OPERATOR, VIEWER, BASE } = require("./lib.cjs");

const campaignId = fs.readFileSync(path.join(__dirname, "campaign-id.txt"), "utf8").trim();
const sql = (q) => execSync(`docker exec mailapp-postgres psql -U mailapp -d mailapp_guide -tAc "${q.replace(/"/g, '\\"')}"`).toString().trim();

async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`!! ${label}: ${e.message.split("\n")[0]}`);
  }
}

(async () => {
  const { browser, page } = await launch();
  await login(page, ADMIN);

  // ---- Dashboard and campaign list ----
  await goto(page, "/");
  await shot(page, "02-dashboard");
  await goto(page, "/campaigns");
  await shot(page, "20-campaigns-list");

  // ---- Campaign detail tabs ----
  await goto(page, `/campaigns/${campaignId}`);
  await shot(page, "21-campaign-overview");
  await safe("leads tab", async () => {
    await page.getByRole("button", { name: /^Leads/ }).click();
    await page.waitForTimeout(600);
    await shot(page, "22-campaign-leads");
  });
  await safe("review tab", async () => {
    await page.getByRole("button", { name: /^Review queue/ }).click();
    await page.waitForTimeout(800);
    await shot(page, "23-campaign-review-tab");
  });
  await safe("stats tab", async () => {
    await page.getByRole("button", { name: /^Stats/ }).click();
    await page.waitForTimeout(800);
    await shot(page, "24-campaign-stats");
  });
  await safe("access tab", async () => {
    await page.getByRole("button", { name: /^Access/ }).click();
    await page.waitForTimeout(500);
    await field(page, "User").selectOption({ label: await page.locator("div:has(> label:text-is('User')) option", { hasText: OPERATOR.name }).first().textContent() });
    await field(page, "Level").selectOption("edit");
    await page.waitForTimeout(200);
    await shot(page, "25-campaign-access-form");
    await page.getByRole("button", { name: /Grant access|Change level/ }).click();
    await page.waitForTimeout(800);
    await shot(page, "26-campaign-access-granted");
  });

  // ---- Lead detail ----
  await safe("lead detail", async () => {
    const leadId = sql(`select id from leads where campaign_id='${campaignId}' and status in ('pending_review','sent','scheduled','researched','drafting') order by row_number limit 1`) || sql(`select id from leads where campaign_id='${campaignId}' order by row_number limit 1`);
    await goto(page, `/leads/${leadId}`);
    await shot(page, "27-lead-detail");
  });

  // ---- Review queue: approve one, reject dialog, regenerate dialog ----
  await goto(page, "/review");
  await shot(page, "30-review-queue");
  await safe("reject dialog", async () => {
    await page.getByRole("button", { name: "Reject" }).first().click();
    await page.waitForTimeout(300);
    await shot(page, "31-review-reject-dialog", { fullPage: false });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Cancel$/ }).first().click().catch(() => {});
  });
  await safe("regenerate dialog", async () => {
    await page.getByRole("button", { name: "Regenerate" }).first().click();
    await page.waitForTimeout(300);
    await shot(page, "32-review-regenerate-dialog", { fullPage: false });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Cancel$/ }).first().click().catch(() => {});
  });
  await safe("approve", async () => {
    await page.getByRole("button", { name: /^Approve$/ }).first().click();
    await page.waitForTimeout(1200);
    await shot(page, "33-review-after-approve", { fullPage: false });
  });
  await safe("edit then approve", async () => {
    const body = page.locator("textarea").first();
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await page.waitForTimeout(200);
    await shot(page, "34-review-edited-draft", { fullPage: false });
    await page.getByRole("button", { name: "Save & approve" }).first().click();
    await page.waitForTimeout(1200);
  });

  // ---- Approve-all confirmation and pause/resume on the campaign ----
  await goto(page, `/campaigns/${campaignId}`);
  await safe("approve all dialog", async () => {
    await page.getByRole("button", { name: /Approve all/ }).click();
    await page.waitForTimeout(300);
    await shot(page, "35-campaign-approve-all-confirm", { fullPage: false });
    await page.getByRole("button", { name: /^Cancel$/ }).first().click();
  });
  await safe("pause", async () => {
    await page.getByRole("button", { name: "Pause" }).click();
    await page.waitForTimeout(1000);
    await shot(page, "36-campaign-paused", { fullPage: false });
    await page.getByRole("button", { name: "Resume" }).click();
    await page.waitForTimeout(1000);
  });

  // ---- Services, link page manager, public link page ----
  await goto(page, "/services");
  await shot(page, "40-services");
  await safe("service form", async () => {
    await page.getByRole("button", { name: /Add service|New service/ }).click();
    await page.waitForTimeout(300);
    await shot(page, "41-service-form", { fullPage: false });
    await page.getByRole("button", { name: /^Cancel$/ }).first().click();
  });
  await goto(page, "/services/landing");
  await shot(page, "42-link-page-manager");
  await safe("public link page", async () => {
    const token = sql(`select unsubscribe_token from leads where campaign_id='${campaignId}' order by row_number limit 1`);
    await goto(page, `/u/${token}`);
    await shot(page, "43-link-page-public");
    const unsub = page.getByRole("button", { name: /unsubscribe/i }).first();
    if (await unsub.count()) {
      await unsub.click();
      await page.waitForTimeout(300);
      await shot(page, "44-link-page-unsubscribe-confirm");
      await page.getByRole("button", { name: /Yes, unsubscribe/i }).click();
      await page.waitForTimeout(600);
      await shot(page, "45-link-page-unsubscribed");
      await page.getByRole("button", { name: /Subscribe again/i }).click();
      await page.waitForTimeout(600);
    }
  });

  // ---- Instructions ----
  await goto(page, "/instructions");
  await shot(page, "50-instructions");
  await safe("instruction form", async () => {
    await page.getByRole("button", { name: /New instruction|Add instruction|New document/ }).click();
    await page.waitForTimeout(300);
    await shot(page, "51-instruction-form", { fullPage: false });
    await page.getByRole("button", { name: /^Cancel$/ }).first().click();
  });

  // ---- Suppressions, settings, users, audit, system, profile ----
  await goto(page, "/suppressions");
  await shot(page, "60-suppressions");
  await goto(page, "/settings");
  await shot(page, "70-settings");
  await goto(page, "/users");
  await shot(page, "80-users");
  await safe("user form", async () => {
    await page.getByRole("button", { name: "Add user" }).click();
    await page.waitForTimeout(300);
    await shot(page, "81-user-form", { fullPage: false });
    await page.getByRole("button", { name: /^Cancel$/ }).first().click();
  });
  await goto(page, "/audit");
  await shot(page, "90-audit");
  await safe("audit filters", async () => {
    await page.getByLabel("Filter by action").selectOption("campaign");
    await page.waitForTimeout(800);
    await shot(page, "91-audit-filtered");
  });
  await goto(page, "/system");
  await shot(page, "95-system");
  await goto(page, "/profile");
  await shot(page, "96-profile");

  // ---- Operator view ----
  await page.context().clearCookies();
  await login(page, OPERATOR);
  await goto(page, "/");
  await shot(page, "05-operator-dashboard");
  await goto(page, "/campaigns");
  await shot(page, "06-operator-campaigns");
  await goto(page, `/campaigns/${campaignId}`);
  await shot(page, "07-operator-campaign-detail", { fullPage: false });

  // ---- Viewer view ----
  await page.context().clearCookies();
  await login(page, VIEWER);
  await goto(page, "/campaigns");
  await shot(page, "08-viewer-campaigns", { fullPage: false });

  await browser.close();
  console.log("SHOTS DONE");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
