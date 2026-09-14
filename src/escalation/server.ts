// A minimal, real operator console: it is intentionally not a polished
// co-browsing UI (out of scope per the brief), but every action it exposes
// acts on the exact same Playwright `Page` the automation was driving, and
// every human action taken here is recorded into the run's evidence log.
import express from "express";
import type { EscalationController } from "./controller.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { captureSnapshot, formatSnapshotForModel } from "../observation/snapshot.js";
import { resolveLocator } from "../observation/resolve.js";

export function startOperatorServer(controller: EscalationController, logger: EvidenceLogger, port: number) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.get("/operator", async (_req, res) => {
    if (!controller.isEscalated || !controller.page) {
      res.send(renderPage("<h2>No intervention pending</h2><p>Automation is currently in control.</p>"));
      return;
    }
    const snapshot = await captureSnapshot(controller.page);
    const req_ = controller.currentRequest!;
    res.send(
      renderPage(`
        <h2>Intervention requested</h2>
        <table border="1" cellpadding="6">
          <tr><td>Capability</td><td>${escapeHtml(req_.capability)}</td></tr>
          <tr><td>Goal</td><td>${escapeHtml(req_.goal ?? "")}</td></tr>
          <tr><td>Step index</td><td>${req_.stepIndex}</td></tr>
          <tr><td>Current URL</td><td>${escapeHtml(req_.currentUrl)}</td></tr>
          <tr><td>Reason</td><td>${escapeHtml(req_.reason)}</td></tr>
        </table>
        <h3>Live page</h3>
        <img src="/operator/screenshot?ts=${Date.now()}" style="max-width:800px;border:1px solid #999" />
        <pre style="white-space:pre-wrap;border:1px solid #ccc;padding:8px;max-width:800px;">${escapeHtml(
          formatSnapshotForModel(snapshot)
        )}</pre>
        <h3>Take a manual action on the live session</h3>
        <form method="post" action="/operator/action">
          <table cellpadding="4">
            <tr><td>Action</td><td>
              <select name="actionType">
                <option value="click">click</option>
                <option value="type">type</option>
                <option value="navigate">navigate</option>
              </select>
            </td></tr>
            <tr><td>Role (for click/type)</td><td><input name="role" placeholder="e.g. link, button, textbox"></td></tr>
            <tr><td>Accessible name (for click/type)</td><td><input name="name" placeholder="e.g. Continue"></td></tr>
            <tr><td>Text value (for type)</td><td><input name="value"></td></tr>
            <tr><td>URL (for navigate)</td><td><input name="url"></td></tr>
            <tr><td colspan="2"><input type="submit" value="Perform action"></td></tr>
          </table>
        </form>
        <h3>Done</h3>
        <form method="post" action="/operator/resume">
          <input type="submit" value="Resume automation">
        </form>
      `)
    );
  });

  app.get("/operator/screenshot", async (_req, res) => {
    if (!controller.page) {
      res.status(404).end();
      return;
    }
    const buf = await controller.page.screenshot();
    res.type("png").send(buf);
  });

  app.post("/operator/action", async (req, res) => {
    if (!controller.isEscalated || !controller.page) {
      res.redirect("/operator");
      return;
    }
    const body = req.body as { actionType?: string; role?: string; name?: string; value?: string; url?: string };
    const actionType = body.actionType ?? "";
    const role = body.role ?? "";
    const name = body.name ?? "";
    const value = body.value ?? "";
    const url = body.url ?? "";
    try {
      if (actionType === "navigate") {
        await controller.page.goto(url);
        controller.recordHumanAction("navigate", { url });
      } else if (actionType === "click") {
        const { locator } = await resolveLocator(controller.page, [{ kind: "role", role, name }]);
        await locator.click();
        controller.recordHumanAction("click", { role, name });
      } else if (actionType === "type") {
        const { locator } = await resolveLocator(controller.page, [{ kind: "role", role, name }]);
        await locator.fill(value);
        controller.recordHumanAction("type", { role, name, value: "[value provided by operator]" });
      }
      await logger.log("human_action", { actionType, role, name });
    } catch (err) {
      await logger.log("error", { source: "operator", message: (err as Error).message });
    }
    res.redirect("/operator");
  });

  app.post("/operator/resume", async (_req, res) => {
    await logger.log("escalation", { event: "resumed_by_human", humanActions: controller.humanActions });
    controller.resume();
    res.send(renderPage("<h2>Resumed</h2><p>Automation has been handed control back.</p>"));
  });

  const server = app.listen(port, () => {
    console.log(`[operator] console listening on http://localhost:${port}/operator`);
  });
  return server;
}

function renderPage(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Operator Console</title></head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
