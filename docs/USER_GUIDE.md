# Outreach Engine

## User Guide and Training Manual

| Field | Value |
|---|---|
| Product | Outreach Engine, the internal outreach console |
| Address | https://outreach.somvanshitechnologies.digital |
| Document version | 1.0 |
| Date | 2026-09-25 |
| Audience | Everyone who will use the console: administrators, operators and viewers |

This guide walks through the software screen by screen. It starts with signing in, then the
one-time setup an administrator does, then the daily work of running a campaign and reviewing
drafts, and finally monitoring and troubleshooting. Every screenshot was taken on a demonstration
copy of the software filled with sample companies; the screens look the same in production.

## Table of contents

1. What the software does
2. Roles and what each role can do
3. Signing in and finding your way around
4. One-time setup (administrator)
5. Your own profile and sender address
6. Preparing a lead sheet
7. Creating a campaign
8. Starting a campaign and what happens next
9. Reviewing and approving drafts
10. Following a campaign: overview, leads, stats
11. Sharing a campaign with other users
12. Replies, bounces and unsubscribes
13. The link page recipients see
14. Managing users (administrator)
15. Audit log and System page
16. Daily checklist
17. Questions and answers
18. Glossary

<div style="page-break-after: always;"></div>

## 1. What the software does

Outreach Engine sends personalised cold emails to a list of contacts, one contact at a time, and
follows up automatically. For every contact it:

1. **Researches** the person and their company from the details in your spreadsheet, using the
   Claude model.
2. **Picks the service** from your catalogue that fits them best.
3. **Writes a short, personal email** following your tone, format and rules documents.
4. **Checks the draft** against hard rules (word count, banned phrases, number of links).
5. **Waits for a person to approve it** (manual mode) or sends it straight away when it passes
   the checks (auto mode).
6. **Sends through Amazon SES** from your own domain and **tracks** delivery, opens, clicks,
   bounces, complaints and replies.
7. **Schedules follow-ups** on the days you set, in the same email thread, and stops the
   sequence as soon as the contact replies, bounces or unsubscribes.

Everything is driven from the browser. There is nothing to install.

## 2. Roles and what each role can do

Every login has one role. An administrator assigns it when creating the account.

| Role | Can do | Cannot do |
|---|---|---|
| **Viewer** | Open the dashboard, look at campaigns they were given access to, read drafts, leads and stats | Change anything |
| **Operator** | Everything a viewer can, plus create campaigns, start, pause and resume them, approve, edit, reject and regenerate drafts, manage their own instruction documents and sender profile | Touch campaigns created by other people (unless an admin grants access), manage users, change organisation settings |
| **Administrator** | Everything: all campaigns, organisation settings, services, organisation-wide instructions, the link page, users, the audit log, stopping any user's sending | |

**Who sees what.** An operator only sees campaigns they created, plus campaigns an administrator
has shared with them (section 11). The dashboard numbers follow the same rule unless the
administrator sets the user's dashboard scope to "all".

## 3. Signing in and finding your way around

Open https://outreach.somvanshitechnologies.digital in Chrome, Edge or Firefox. Enter the email
address and password the administrator gave you.

![Login screen](user-guide/01-login.png)

After five wrong passwords the account is locked for fifteen minutes. If you forget your password,
an administrator can set a new one on the Users page.

Once signed in you land on the **Dashboard**.

![Dashboard](user-guide/02-dashboard.png)

The screen has three areas:

- **Left menu.** Every page of the console. Administrators see two extra entries, Users and Audit log.
- **Top bar.** A yellow badge appears when the system is in test mode (emails are not really sent);
  in production there is no badge. Your name, role and the Log out button are on the right.
- **Bottom left.** The software version and how many emails have gone out today against the
  daily limit.

The dashboard shows, for the period you choose: emails sent, delivered, opened, clicked, replied,
bounced and complained, the same numbers over time, recent delivery events, the health of the
sending account and how much the model has been used.

Your session stays signed in for fourteen days on the same browser. Use **Log out** on a shared
computer.

<div style="page-break-after: always;"></div>

## 4. One-time setup (administrator)

Do these once, in this order, before the first campaign. Each takes a few minutes.

### 4.1 Settings

Menu: **Settings**. This page holds the organisation-wide defaults.

![Settings page](user-guide/70-settings.png)

Work through the sections from the top:

| Section | What to set |
|---|---|
| **Inbox placement** | Delivery mode. *Personal* (recommended) sends plain, one-to-one style emails that land in the Primary tab. *Bulk* adds tracking and unsubscribe headers used by newsletters. |
| **Reply capture** | Whether replies that arrive on the reply domain are forwarded to the campaign owner's mailbox. Leave on. |
| **Sending** | The default From email and From name (must be on the verified domain), an optional Reply-to, the daily cap across all campaigns, the send rate per second and the default approval mode for new campaigns. |
| **Postal address** | Printed at the bottom of every email. |
| **LLM** | Which Claude model drafts and which one researches, and whether research may use web search. |
| **Hard rules** | The automatic validator: minimum and maximum words, maximum subject length, maximum links, banned phrases, required phrases, domains never to contact, and switches to forbid emojis, links, exclamation marks and ALL-CAPS words. A draft that breaks a rule is regenerated automatically, and if it still fails it is flagged in the review queue. |
| **Track opens / Track clicks** | Whether the mail system records opens and clicks. Turning opens off sends text-only email, which is the cleanest for inbox placement but means the Opened figures stay empty. |
| **Sending window** | Start hour, end hour, timezone and days of the week on which emails may go out. Emails approved outside the window wait for the next slot. |

Press **Save** at the top right. **Export xlsx** downloads all settings, hard rules, instruction
documents and services in one spreadsheet, useful as a backup or to copy to another installation.

### 4.2 Services

Menu: **Services**. This is the catalogue the model chooses from when it decides what to pitch to
a contact. The better the descriptions, the better the emails.

![Services](user-guide/40-services.png)

Press **Add service** and fill in the form.

![Service form](user-guide/41-service-form.png)

| Field | Guidance |
|---|---|
| Name | Short and recognisable, as it may appear in emails and on the link page. |
| URL | The page on your website; the link page uses it for the "Learn more" button. |
| Description | What it is, how it is delivered, typical outcomes. Two or three sentences. |
| Target audience | Who it is for, so the model can judge fit. |
| Value propositions | One per line. Concrete benefits, not slogans. |
| Proof points | Real results and case studies. The model may only claim what is written here. |
| Tags | Free keywords for your own filtering. |

Deactivate a service instead of deleting it when you stop offering it. Inactive services are not
pitched but past emails keep their history. **Import xlsx** loads many services at once from a
sheet with the same column names.

### 4.3 Instructions

Menu: **Instructions**. These documents are injected into every draft the model writes. Four
kinds exist:

| Kind | Purpose | Example |
|---|---|---|
| Tone | How the email should sound | "Warm, direct and specific. No hype words. No exclamation marks." |
| Format | Structure and length | "Greeting on its own line, two to four short paragraphs, one question as the call to action." |
| Rules | What the model must never do | "Never invent numbers, customers or quotes. Never mention pricing." |
| Signature | The sign-off appended to every email | "Best regards, Vigneya Bhatt, Somvanshi Technologies" |

![Instructions](user-guide/50-instructions.png)

The software ships with sensible defaults for all four. Edit them rather than starting from
scratch. Press **New instruction** to add a document or **Upload file** to load a .md, .txt or
.docx file.

![Instruction form](user-guide/51-instruction-form.png)

**Edit (new version)** on a document saves your changes as a new version and keeps the old one
inactive (tick **Show inactive** to see it). **Deactivate** switches a document off without
deleting it. Only active documents are used.

**Organisation and personal documents.** Administrators manage the organisation documents that
apply to everyone. The page has two tabs, **Organisation** and **Mine**. Each user can write personal
documents under Mine; a personal document of a kind replaces the organisation document of that kind for
that user's campaigns only. Changes affect drafts written from then on; use **Regenerate** on a
draft to apply them to something already in the queue.

### 4.4 Link page

Every email carries one small link at the bottom (by default "Manage preferences"). It opens a
page that shows your services and lets the recipient contact you or, if you enable it, unsubscribe.
Section 13 describes it. Configure it under **Services → Manage link page**.

### 4.5 Users

Create a login for each colleague under **Users** (section 14). At minimum set their name, email,
role and password. If they will send from their own address, fill in their From name and From
email too.

<div style="page-break-after: always;"></div>

## 5. Your own profile and sender address

Menu: **My profile**. Every user has one.

![My profile](user-guide/96-profile.png)

- **Sender identity.** Display name, From name, From email, Reply-to and postal address. Blank
  fields fall back to the organisation settings. Emails from campaigns you own go out with these
  details. The From email must be an address on the verified company domain; the page refuses
  anything else and tells you which domains are allowed.
- **Reply polling (IMAP).** If you want the console to notice replies that land in your own
  mailbox, enter your mailbox's IMAP host, port, username, folder and password and turn it on.
  The console reads the mailbox every few minutes without changing or deleting anything. **Test
  connection** checks the details before you save. This is optional; replies to the reply domain
  are captured automatically without it.
- **Password.** Change your own password here. All other sessions are signed out when you do.

## 6. Preparing a lead sheet

A campaign starts from an Excel file (.xlsx) or CSV with one contact per row. The first row must
be the column headings.

| Column | Required | Notes |
|---|---|---|
| Email | Yes | One address per row. Rows without a valid address are skipped and reported. |
| First name, Last name | Recommended | Used in the greeting. |
| Company | Recommended | Drives the research. |
| Job title | Recommended | Helps the model pitch at the right level. |
| Website | Recommended | The model reads it during research when web search is on. |
| LinkedIn, Industry, Location, Phone | Optional | Extra context. |
| Notes | Optional | Anything you know about the person. It is used verbatim by the model, so write it as facts ("expanding to Dubai in 2027"). |

Column names are matched flexibly ("First Name", "first_name" and "FirstName" all work). Columns
the software does not recognise are kept as extra data and shown on the lead's page.

Before uploading, remove anyone who has asked not to be contacted. The software also checks every
address against the suppression list (section 12) and skips those automatically.

<div style="page-break-after: always;"></div>

## 7. Creating a campaign

Menu: **Campaigns → New campaign**. The wizard has three steps.

### Step 1: Upload leads

Choose the lead sheet. The console analyses it immediately and shows how each column was
understood and the first rows.

![Step 1, upload](user-guide/11-new-campaign-step1-preview.png)

Check the **Mapped columns** table: every important column should map to a field on the right.
If a column ended up under **Unmapped columns**, rename the heading in the sheet and upload again.
Press **Continue**.

### Step 2: Configure

![Step 2, configure](user-guide/12-new-campaign-step2-configure.png)

| Setting | What it does |
|---|---|
| Campaign name | How it appears in lists and reports. |
| Approval mode | **Manual review**: every draft waits for a person in the review queue. **Auto-send**: drafts that pass the hard rules are sent without review. Start with manual until you trust the output. |
| Description | Notes for colleagues. |
| Follow-up sequence | Step 1 is the first email. Each later step has a delay in days after the previous email was sent, guidance for the model, and a "Threaded" switch that keeps it in the same conversation (reply subject and quoted thread). Add or remove steps as needed; three steps is a good default. |
| Services to pitch | Tick services to limit the campaign to them, or leave all unticked to let the model choose from every active service. |
| Sender | Optional From email, From name and Reply-to for this campaign only. Blank means your profile, then the organisation settings. |
| Extra guidance | Campaign-specific instructions added to the instruction documents, for example "Mention that we are based in Pune". |
| Max words override, Additional banned phrases | Tighten the hard rules for this campaign only. |

Press **Continue**.

### Step 3: Review and create

![Step 3, summary](user-guide/13-new-campaign-step3-review.png)

Check the summary and press **Create campaign**. Nothing is sent yet: the campaign is created in
**Draft** state.

### Editing a draft campaign

![Draft campaign](user-guide/14-campaign-draft-detail.png)

While a campaign is in Draft, the **Edit** button (and the **Edit campaign** tab) let you change
the name, description, approval mode, sequence, services, sender and guidance. After the start the
same tab is called **Sequence & settings** and is read-only.

![Editing the sequence and settings](user-guide/15-campaign-draft-edit-settings.png)

Once the campaign is started these settings are locked. To change the sequence or sender later,
pause or archive the campaign and create a new one.

<div style="page-break-after: always;"></div>

## 8. Starting a campaign and what happens next

Press **Start campaign** on the campaign page and confirm.

![Start confirmation](user-guide/16-campaign-start-confirm.png)

The campaign becomes **Active** and the pipeline begins for every contact:

![Campaign just started](user-guide/17-campaign-running.png)

| Stage | What is happening | Typical time |
|---|---|---|
| Pending | Waiting for a free slot. | Seconds to minutes |
| Researching | The model builds a short profile of the person and company, and matches services. | About one minute per contact |
| Drafting | The model writes the email for the current step and the validator checks it. | Under a minute |
| Pending review | The draft is waiting for you in the review queue (manual mode). | Until you act |
| Approved / Scheduled | Approved and waiting for the sending window or the follow-up date. | |
| Sent, Delivered, Opened, Clicked, Replied | Tracked from the mail system. | |
| Bounced, Complained, Unsubscribed, Failed | The sequence stops for this contact. | |

The **Pipeline** boxes on the campaign Overview show how many contacts are in each stage. Refresh
the page to see progress. The **Leads** tab lists every contact and, for scheduled follow-ups, the
exact date and time the next email will go out.

**Pause** stops new research, drafting and sending immediately; emails already approved stay
approved. **Resume** picks up where it left off. **Archive** ends the campaign for good.

## 9. Reviewing and approving drafts

Menu: **Review queue**. It lists every draft waiting for approval across the campaigns you can
see. The **Review queue** tab inside a campaign shows only that campaign's drafts.

![Review queue](user-guide/30-review-queue.png)

Each entry shows, on the left, what the model found: the person's role, a summary of the company,
personalisation hooks it used, pain points, the matched services with a fit score and the pitch
angle. On the right is the email itself: subject and body, both editable, and any validator
warnings underneath.

For each draft you can:

| Button | Effect |
|---|---|
| **Approve** | The email is queued to send (within the sending window). If you changed the text the button reads **Save & approve** and your version is sent. |
| **Regenerate** | Ask the model for a fresh draft, optionally with a note on what to change ("shorter", "lead with the data angle"). The old draft is discarded. |
| **Reject** | Nothing is sent to this contact for this step; give a reason for the record. The contact is marked as skipped. |

![Regenerate with a note](user-guide/32-review-regenerate-dialog.png)

![Reject with a reason](user-guide/31-review-reject-dialog.png)

**Edit before approving.** Click into the subject or body, change what you like, then press
Save & approve. An "Unsaved edits" note reminds you that the text differs from the model's draft.

![Edited draft ready to approve](user-guide/34-review-edited-draft.png)

**Approve everything at once.** On the campaign page, **Approve all** (the number in brackets is
how many are waiting) approves every pending draft in that campaign after a confirmation. Use it
only after you have read a good sample.

![Approve all confirmation](user-guide/35-campaign-approve-all-confirm.png)

**Follow-ups also come here.** In manual mode, every follow-up step is drafted a little before its
due date and waits in the queue like a first email. Approve them the same way.

<div style="page-break-after: always;"></div>

## 10. Following a campaign: overview, leads, stats

Menu: **Campaigns** lists every campaign you can see with its status, owner, lead count and your
access level.

![Campaign list](user-guide/20-campaigns-list.png)

Open one to see the tabs.

**Overview** shows the funnel (leads, sent, delivered, opened, clicked, replied), the pipeline
counts, the import summary and the timeline.

![Campaign overview](user-guide/21-campaign-overview.png)

**Leads** lists every contact with status, current step, next send time and last error. Filter by
status or search by name, email or company. Click a name to open the lead page.

![Leads tab](user-guide/22-campaign-leads.png)

**Lead page.** Everything about one contact: the profile the model built, milestones (sent,
delivered, opened, replied), matched services, the full email thread with every step, delivery
events and send attempts. The buttons at the top let you **Retry** a failed contact, **Re-research** them so the next
draft starts from a fresh profile, **Mark replied** when a reply arrived somewhere the console could
not see, **Skip** them, or **Unsubscribe** them on request.

![Lead page](user-guide/27-lead-detail.png)

**Stats** breaks the numbers down by step and over time.

![Stats tab](user-guide/24-campaign-stats.png)

**Export status xlsx** (top right of the campaign page) downloads every contact with their status,
timestamps and the text of each email sent, for reporting or for loading into a CRM.

## 11. Sharing a campaign with other users

Operators only see their own campaigns. An administrator can share a campaign from its **Access**
tab.

![Granting access](user-guide/25-campaign-access-form.png)

| Level | The user can |
|---|---|
| View | Open the campaign, read leads, drafts and stats. |
| Edit | Also approve, edit, reject and regenerate drafts. |
| Full | Also start, pause, resume, archive and export, the same as the owner. |

![Access granted](user-guide/26-campaign-access-granted.png)

The list shows every user with access; **Revoke** removes it. Viewers are always capped at
View regardless of the level chosen. Administrators have full access to every campaign without
being listed.

This is how the console looks to an operator who was granted **Edit** on a colleague's campaign:
the campaign appears in their list with the level shown, they can work the review queue, but the
start, pause and archive controls are absent.

![Operator's campaign list](user-guide/06-operator-campaigns.png)

![Operator's view of a shared campaign](user-guide/07-operator-campaign-detail.png)

<div style="page-break-after: always;"></div>

## 12. Replies, bounces and unsubscribes

**Replies.** Emails go out with a Reply-to on the company reply domain. When a contact answers,
the console records the reply, marks the contact as **Replied**, cancels their remaining
follow-ups and forwards the message to the campaign owner's own mailbox, so you answer it from
there like any other email. If a reply arrives elsewhere (for example the contact wrote to a
different address), press **Mark replied** on the lead page so follow-ups stop.

**Bounces and complaints.** A hard bounce or a spam complaint stops the sequence and adds the
address to the suppression list automatically. The dashboard shows both rates; keep bounces under
5% and complaints under 0.1% or the sending account is at risk.

**Suppression list.** Menu: **Suppressions**. Addresses here are never emailed again, by any
campaign. Entries arrive automatically from bounces, complaints and unsubscribes; add one by hand
with **Add address** (for example someone who asked by phone), import a list with **Import**, or
download the whole list with **Export xlsx**. **Remove** an entry only when the person has asked
to hear from you again.

![Suppressions](user-guide/60-suppressions.png)

## 13. The link page recipients see

Every email ends with a small link, "Manage preferences" by default. It opens a public page with
your headline, an introduction, a card for each service with **Learn more** and **Contact**
buttons, and, if you switch it on, an unsubscribe button.

![The link page as a recipient sees it](user-guide/43-link-page-public.png)

Administrators design it under **Services → Manage link page**. The preview on the right updates
as you type.

![Manage link page](user-guide/42-link-page-manager.png)

- **Wording.** The link text used in emails, the headline, the intro, button labels, the contact
  address and a footer note.
- **Unsubscribe button.** Off by default because outreach goes to known contacts. When on, the
  recipient is asked to confirm before being unsubscribed and can undo it with **Subscribe again**.
- **Services on the page.** Choose which services appear, in what order, and which buttons each
  shows. Leave the list empty to show every active service.

![Unsubscribe confirmation](user-guide/44-link-page-unsubscribe-confirm.png)

![After unsubscribing, with the option to subscribe again](user-guide/45-link-page-unsubscribed.png)

<div style="page-break-after: always;"></div>

## 14. Managing users (administrator)

Menu: **Users**.

![Users](user-guide/80-users.png)

The table shows each user's role, whether they are active, the campaigns they own, the emails
they have sent and how many are queued. From here you can:

- **Add user**: name, login email, role, dashboard scope, password, and optionally their own
  From name, From email, Reply-to and postal address.
- **Edit** any of those later, including resetting a password.
- **Deactivate** to block sign-in without losing history.
- **Stop sending**: pauses every active campaign the user owns in one click. Use it when someone
  leaves or a list turns out to be bad.
- **Delete**: removes the account. Their campaigns and history stay, attributed to their name.

![Add user form](user-guide/81-user-form.png)

**Dashboard scope.** "Own" (default) means the user's dashboard counts only their campaigns. "All"
shows organisation-wide numbers to a non-admin without giving them access to other people's
campaigns.

## 15. Audit log and System page

**Audit log** (administrators) records who did what and when: logins, campaigns created and
started, drafts approved or rejected, settings changed, users managed, unsubscribes. Filter by
action group or exact action, user, entity type, entity id and date range, or search the details.
Click a user, action or id in the table to filter by it.

![Audit log](user-guide/90-audit.png)

![Audit log filtered to campaign actions](user-guide/91-audit-filtered.png)

**System** shows whether the database, job queue and sending account are healthy, the queues'
backlog, today's send count against the cap, when the sending statistics were last refreshed and
the status of reply capture. Look here first when something seems stuck.

![System page](user-guide/95-system.png)

## 16. Daily checklist

Ten minutes a day keeps campaigns moving.

1. Open **Review queue** and work through waiting drafts: approve, edit, regenerate or reject.
2. Glance at the **Dashboard**: are bounces or complaints rising? If so, pause the campaign and
   look at the lead source.
3. Check your mailbox for forwarded replies and answer them.
4. On each active campaign's **Leads** tab, look at contacts marked **Failed** and press Retry or
   Skip.
5. Once a week, download **Export status xlsx** for reporting.

## 17. Questions and answers

**Nothing is happening after I started the campaign.** Research takes about a minute per contact
and only a few run at once. Refresh the campaign page after a couple of minutes. If the Pipeline
boxes still do not move, check the **System** page for a queue error and tell the administrator.

**A draft says it failed validation.** The model broke a hard rule (usually too many words or a
banned phrase). Press Regenerate, or edit the text yourself and Save & approve.

**Can I change the follow-up days after starting?** No. Pause or archive the campaign and create a
new one with the right sequence; contacts already emailed can be left out of the new sheet.

**An email was approved but has not been sent.** Sending only happens inside the sending window
set in Settings, and the daily cap may have been reached (see the bottom left of the screen). It
goes out at the next opportunity.

**Someone asked to stop receiving emails.** Open their lead page and press Unsubscribe, or add
their address on the Suppressions page. All follow-ups stop immediately.

**A colleague cannot see my campaign.** Ask an administrator to grant them access from the
campaign's Access tab.

**I want to send from a different address.** Set it under My profile. It must be on the verified
company domain; the page tells you if it is not.

**Why does the model sometimes pitch the "wrong" service?** It chooses from the descriptions in
Services. Improve the target audience and value propositions there, or tick specific services in
the campaign's settings.

## 18. Glossary

| Term | Meaning |
|---|---|
| Campaign | One lead sheet plus one sequence of emails. |
| Lead | One contact in a campaign. |
| Sequence, step | The planned emails to a contact: step 1 is the first email, later steps are follow-ups. |
| Draft | An email the model has written but that has not been sent. |
| Review queue | Drafts waiting for a person to approve them. |
| Hard rules | Automatic checks every draft must pass. |
| Instruction documents | Tone, format, rules and signature text given to the model. |
| Services | The catalogue of what you offer. |
| Suppression list | Addresses that must never be emailed. |
| Link page | The public page behind the small link at the bottom of each email. |
| Sending window | Hours and days during which emails may go out. |
| Daily cap | Maximum emails per day across all campaigns. |
| SES | Amazon Simple Email Service, the system that delivers the emails. |
