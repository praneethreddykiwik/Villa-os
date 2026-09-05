import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Load .env.local if present
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const {
  checkGoogleSheetsStatus,
  extractSpreadsheetId,
  googleSheetsApiKey,
  isGoogleSheetsConfigured,
  parseLeadsFromSheet,
} = require("../src/lib/sheets/client");

describe("Google Sheets client unit tests", () => {
  test("configuration checks", () => {
    const prev = process.env.GOOGLE_SHEETS_API_KEY;
    try {
      delete process.env.GOOGLE_SHEETS_API_KEY;
      assert.equal(isGoogleSheetsConfigured(), false);

      process.env.GOOGLE_SHEETS_API_KEY = "AIzaSyTest";
      assert.equal(isGoogleSheetsConfigured(), true);
      assert.equal(googleSheetsApiKey(), "AIzaSyTest");
    } finally {
      if (prev) process.env.GOOGLE_SHEETS_API_KEY = prev;
    }
  });

  test("extractSpreadsheetId correctly parses URLs and IDs", () => {
    const url1 = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0";
    assert.equal(extractSpreadsheetId(url1), "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");

    const url2 = "https://docs.google.com/spreadsheets/d/1a2b3c4d5e6f/edit?usp=sharing";
    assert.equal(extractSpreadsheetId(url2), "1a2b3c4d5e6f");

    const bareId = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
    assert.equal(extractSpreadsheetId(bareId), "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
  });

  test("parseLeadsFromSheet maps sheet rows into Villa-OS leads", () => {
    const sampleTable = [
      ["Full Name", "Phone", "Email", "Budget Min", "Budget Max", "Stage", "Source", "Notes"],
      ["Rajesh Sharma", "+91 98765 43210", "rajesh@example.com", "20000000", "35000000", "negotiation", "referral", "Looking for 4BHK"],
      ["Anita Desai", "9123456789", "anita@example.com", "55000000", "75000000", "site_visit", "portal", "Interested in East-facing villa"],
      ["", "", "", "", "", "", "", ""],
    ];

    const leads = parseLeadsFromSheet(sampleTable);
    assert.equal(leads.length, 2);

    assert.equal(leads[0].name, "Rajesh Sharma");
    assert.equal(leads[0].phone, "+91 98765 43210");
    assert.equal(leads[0].status, "negotiation");
    assert.equal(leads[0].source, "referral");
    assert.equal(leads[0].budgetMin, 20000000);
    assert.equal(leads[0].budgetMax, 35000000);

    assert.equal(leads[1].name, "Anita Desai");
    assert.equal(leads[1].isHNWI, true);
    assert.equal(leads[1].status, "site_visit_scheduled");
  });
});

describe("Google Sheets live API verification", () => {
  test("Google Cloud accepts and validates the API key", async (t) => {
    if (!process.env.GOOGLE_SHEETS_API_KEY) {
      t.skip("GOOGLE_SHEETS_API_KEY not configured in environment");
      return;
    }

    let status;
    try {
      status = await checkGoogleSheetsStatus();
    } catch (e) {
      t.skip(`Network unreachable: ${(e as Error).message}`);
      return;
    }

    if (status.error === "NETWORK_ERROR" || status.message?.includes("fetch failed")) {
      t.skip(`Network unreachable (sandboxed): ${status.message}`);
      return;
    }

    assert.equal(status.configured, true);
    assert.equal(status.valid, true, `Google Sheets API key rejected: ${status.message}`);
  });
});
