// Re-captures the shots that failed in shots.cjs: campaign tabs, access grant, user form,
// a compact review-queue shot, the operator views, and the Instructions "Mine" tab.
const fs = require("fs");
const path = require("path");
const { launch, login, shot, goto, field, ADMIN, OPERATOR, SHOTS } = require("./lib.cjs");

const campaignId = fs.readFileSync(path.join(__dirname, "campaign-id.txt"), "utf8").trim();
async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`!! ${label}: ${e.message.split("\n")[0]}`);
  }
}
const tab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

(async () => {
  const { browser, page } = await launch();
  await login(page, ADMIN);

  await goto(page, `/campaigns/${campaignId}`);
  await safe("leads", async () => {
    await tab(page, "Leads").click();
    await page.waitForTimeout(800);
    await shot(page, "22-campaign-leads");
  });
  await safe("review tab", async () => {
    await tab(page, "Review queue").click();
    await page.waitForTimeout(800);
    await shot(page, "23-campaign-review-tab", { fullPage: false });
  });
  await safe("stats", async () => {
    await tab(page, "Stats").click();
    await page.waitForTimeout(1000);
    await shot(page, "24-campaign-stats");
  });
  await safe("access", async () => {
    await tab(page, "Access").click();
    await page.waitForTimeout(500);
    const opt = page.locator("div:has(> label:text-is('User')) option", { hasText: OPERATOR.name }).first();
    await field(page, "User").selectOption(await opt.getAttribute("value"));
    await field(page, "Level").selectOption("edit");
    await page.waitForTimeout(200);
    await shot(page, "25-campaign-access-form");
    await page.getByRole("button", { name: /Grant access|Change level/ }).click();
    await page.waitForTimeout(800);
    await shot(page, "26-campaign-access-granted");
  });

  // Compact review queue: just the first card.
  await goto(page, "/review");
  await safe("review card", async () => {
    const card = page.locator("textarea").first().locator("xpath=ancestor::div[contains(@class,'card')][1]");
    await card.screenshot({ path: path.join(SHOTS, "30-review-queue.png") });
    console.log("shot 30-review-queue (card)");
    await shot(page, "30b-review-queue-top", { fullPage: false });
  });

  await safe("lead viewport", async () => {
    const id = require("child_process")
      .execSync(`docker exec mailapp-postgres psql -U mailapp -d mailapp_guide -tAc "select id from leads where campaign_id='${campaignId}' and status='pending_review' order by row_number limit 1"`)
      .toString()
      .trim();
    await goto(page, `/leads/${id}`);
    await shot(page, "27-lead-detail", { fullPage: false });
  });

  await goto(page, "/users");
  await safe("user form", async () => {
    await page.waitForSelector("table");
    await page.locator("button", { hasText: "Add user" }).click({ force: true });
    await page.waitForTimeout(400);
    await shot(page, "81-user-form", { fullPage: false });
  });

  await goto(page, "/instructions");
  await safe("mine tab", async () => {
    await page.getByRole("tab", { name: /Mine|My documents/ }).click();
    await page.waitForTimeout(500);
    await shot(page, "52-instructions-mine", { fullPage: false });
  });

  // Operator again, now with edit access on the campaign.
  await page.context().clearCookies();
  await login(page, OPERATOR);
  await goto(page, "/campaigns");
  await shot(page, "06-operator-campaigns", { fullPage: false });
  await goto(page, `/campaigns/${campaignId}`);
  await shot(page, "07-operator-campaign-detail", { fullPage: false });
  await goto(page, "/review");
  await shot(page, "09-operator-review-queue", { fullPage: false });

  await browser.close();
  console.log("TABS DONE");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
