// Mock "legacy core banking" back-office app used as the proxy target for the
// computer-use agent. Deliberately styled like an old server-rendered
// enterprise app: nested tables, no data-testid attributes, no ids on
// interactive controls, minimal semantic markup. The only reliable way to
// find a control is by what a human would see: its role and visible text.
import "dotenv/config";
import express from "express";
import { members, issueAccountNumber, type SubAccount } from "./data.js";

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.TARGET_APP_PORT ?? 4000);

// short-lived pending sub-account requests, keyed by an opaque token, to
// mimic a real confirm-before-submit flow without real server sessions.
const pending = new Map<string, { memberId: string; type: string; deposit: number; notes: string }>();
let tokenSeq = 1;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title} - Core Banking Console</title></head>
<body>
<table width="100%" cellpadding="4" cellspacing="0" border="0">
  <tr><td colspan="2" style="background:#003366;color:white;font-weight:bold;">Core Banking Console (Demo)</td></tr>
  <tr>
    <td valign="top" width="140">
      <table cellpadding="2" cellspacing="0">
        <tr><td><a href="/members">Member Search</a></td></tr>
      </table>
    </td>
    <td valign="top">
      <table cellpadding="6" cellspacing="0" border="0" width="100%">
        <tr><td>${body}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

app.get("/", (_req, res) => res.redirect("/members"));

// --- Member search -----------------------------------------------------
app.get("/members", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  let resultsHtml = "";
  if (q) {
    const member = members.get(q);
    resultsHtml = member
      ? `<table border="1" cellpadding="4" cellspacing="0">
           <tr><td><b>Member ID</b></td><td><b>Name</b></td><td><b>Status</b></td><td></td></tr>
           <tr>
             <td>${member.id}</td>
             <td>${member.name}</td>
             <td>${member.status}</td>
             <td><a href="/members/${member.id}">View</a></td>
           </tr>
         </table>`
      : `<p>No member record found for id "${escapeHtml(q)}".</p>`;
  }
  res.send(
    layout(
      "Member Search",
      `<h3>Member Search</h3>
       <form method="get" action="/members">
         <table cellpadding="4" cellspacing="0">
           <tr><td>Member ID</td><td><input type="text" name="q" value="${escapeHtml(q)}"></td>
           <td><input type="submit" value="Search"></td></tr>
         </table>
       </form>
       ${resultsHtml}`
    )
  );
});

// --- Member detail -------------------------------------------------------
app.get("/members/:id", (req, res) => {
  const { id } = req.params;
  const simulate = req.query.simulate;
  const ack = req.query.ack === "1";

  // Injected, unexpected interstitial used to demonstrate escalation on replay:
  // a state the original discovery run never saw.
  if (simulate === "interstitial" && !ack) {
    res.send(
      layout(
        "Session Renewed",
        `<h3>Session Renewed</h3>
         <p>Your session was silently renewed for security purposes. Please confirm to continue.</p>
         <p><a href="/members/${id}?simulate=interstitial&ack=1">Continue</a></p>`
      )
    );
    return;
  }

  if (simulate === "slow") {
    setTimeout(() => renderMemberDetail(id, res), 2500);
    return;
  }

  // A genuinely unrecognized outage state (unlike the interstitial above,
  // this one is never declared in the artifact's known interstitials/business
  // outcomes) — used to demonstrate escalation to a human, as opposed to
  // automatic recovery. A human would simply retry.
  if (simulate === "outage" && req.query.retry !== "1") {
    res.send(
      layout(
        "System Unavailable",
        `<h3>System Temporarily Unavailable</h3>
         <p>The core banking service is temporarily unavailable. Please retry.</p>
         <p><a href="/members/${id}?retry=1">Retry</a></p>`
      )
    );
    return;
  }

  renderMemberDetail(id, res);
});

function renderMemberDetail(id: string, res: express.Response) {
  const member = members.get(id);
  if (!member) {
    res.status(200).send(
      layout(
        "Not Found",
        `<h3>Member Lookup</h3><p>No member record found for id "${escapeHtml(id)}".</p>`
      )
    );
    return;
  }
  if (member.status === "restricted") {
    res.status(200).send(
      layout(
        "Access Restricted",
        `<h3>Member ${member.id}</h3><p>Access to this member record is restricted. You do not have permission to view these details.</p>`
      )
    );
    return;
  }

  const subAccountRows = member.subAccounts
    .map(
      (a: SubAccount) =>
        `<tr><td>${a.accountNumber}</td><td>${a.type}</td><td>$${a.initialDeposit.toFixed(2)}</td></tr>`
    )
    .join("");

  res.send(
    layout(
      "Member Detail",
      `<h3>Member Detail</h3>
       <table cellpadding="4" cellspacing="0">
         <tr><td>Member ID</td><td>${member.id}</td></tr>
         <tr><td>Name</td><td>${member.name}</td></tr>
         <tr><td>Status</td><td>${member.status}</td></tr>
         <tr><td>Savings Balance</td><td>$${member.savingsBalance.toFixed(2)}</td></tr>
         <tr><td>Checking Balance</td><td>$${member.checkingBalance.toFixed(2)}</td></tr>
       </table>
       <h4>Sub-Accounts</h4>
       <table border="1" cellpadding="4" cellspacing="0">
         <tr><td><b>Account #</b></td><td><b>Type</b></td><td><b>Initial Deposit</b></td></tr>
         ${subAccountRows || "<tr><td colspan=3>None</td></tr>"}
       </table>
       <p><a href="/members/${member.id}/new-subaccount">Open Sub-Account</a></p>`
    )
  );
}

// --- Open sub-account (irreversible, multi-step, confirm required) ------
app.get("/members/:id/new-subaccount", (req, res) => {
  const { id } = req.params;
  const member = members.get(id);
  if (!member || member.status !== "active") {
    res.send(layout("Error", `<p>Cannot open a sub-account for member ${escapeHtml(id)}.</p>`));
    return;
  }
  const error = typeof req.query.error === "string" ? req.query.error : "";
  res.send(
    layout(
      "Open Sub-Account",
      `<h3>Open Sub-Account for ${member.name} (${member.id})</h3>
       ${error ? `<p style="color:red;">${escapeHtml(error)}</p>` : ""}
       <form method="post" action="/members/${member.id}/new-subaccount">
         <table cellpadding="4" cellspacing="0">
           <tr><td>Account Type</td><td>
             <select name="type">
               <option value="savings">Savings</option>
               <option value="money-market">Money Market</option>
             </select>
           </td></tr>
           <tr><td>Initial Deposit</td><td><input type="text" name="deposit"></td></tr>
           <tr><td>Notes</td><td><textarea name="notes"></textarea></td></tr>
           <tr><td colspan="2"><input type="submit" value="Continue"></td></tr>
         </table>
       </form>`
    )
  );
});

app.post("/members/:id/new-subaccount", (req, res) => {
  const { id } = req.params;
  const member = members.get(id);
  if (!member) {
    res.status(404).send(layout("Error", "<p>Member not found.</p>"));
    return;
  }
  const type = String(req.body.type ?? "savings");
  const depositRaw = String(req.body.deposit ?? "").trim();
  const notes = String(req.body.notes ?? "");
  const deposit = Number(depositRaw);

  if (!depositRaw || Number.isNaN(deposit) || deposit < 25 || deposit > 100000) {
    const msg = `Invalid initial deposit "${depositRaw}". Minimum $25, maximum $100,000.`;
    res.redirect(`/members/${id}/new-subaccount?error=${encodeURIComponent(msg)}`);
    return;
  }

  const token = String(tokenSeq++);
  pending.set(token, { memberId: id, type, deposit, notes });
  res.redirect(`/members/${id}/new-subaccount/confirm?token=${token}`);
});

app.get("/members/:id/new-subaccount/confirm", (req, res) => {
  const token = String(req.query.token ?? "");
  const request = pending.get(token);
  const { id } = req.params;
  if (!request || request.memberId !== id) {
    res.send(layout("Expired", "<p>This request has expired or was already submitted.</p>"));
    return;
  }
  res.send(
    layout(
      "Confirm Sub-Account",
      `<h3>Confirm New Sub-Account</h3>
       <table cellpadding="4" cellspacing="0">
         <tr><td>Member</td><td>${id}</td></tr>
         <tr><td>Account Type</td><td>${escapeHtml(request.type)}</td></tr>
         <tr><td>Initial Deposit</td><td>$${request.deposit.toFixed(2)}</td></tr>
         <tr><td>Notes</td><td>${escapeHtml(request.notes)}</td></tr>
       </table>
       <p>This action cannot be undone. Please review carefully before confirming.</p>
       <form method="post" action="/members/${id}/new-subaccount/confirm">
         <input type="hidden" name="token" value="${token}">
         <input type="submit" value="Confirm and Open Account">
       </form>
       <form method="get" action="/members/${id}">
         <input type="submit" value="Cancel">
       </form>`
    )
  );
});

app.post("/members/:id/new-subaccount/confirm", (req, res) => {
  const token = String(req.body.token ?? "");
  const request = pending.get(token);
  const { id } = req.params;
  if (!request || request.memberId !== id) {
    res.send(layout("Expired", "<p>This request has expired or was already submitted.</p>"));
    return;
  }
  pending.delete(token);
  const member = members.get(id);
  if (!member) {
    res.status(404).send(layout("Error", "<p>Member not found.</p>"));
    return;
  }
  const accountNumber = issueAccountNumber();
  member.subAccounts.push({
    accountNumber,
    type: request.type,
    openedAt: new Date().toISOString(),
    initialDeposit: request.deposit,
  });
  res.send(
    layout(
      "Sub-Account Opened",
      `<h3>Sub-Account Opened</h3>
       <p>Success. New account number: <b>${accountNumber}</b></p>
       <p><a href="/members/${id}">Return to member</a></p>`
    )
  );
});

// dev-only reset so the same demo scenarios can be replayed repeatedly
app.post("/__reset", (_req, res) => {
  for (const m of members.values()) m.subAccounts = [];
  pending.clear();
  res.send("ok");
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.listen(PORT, () => {
  console.log(`[target-app] mock core banking console listening on http://localhost:${PORT}`);
});
