/**
 * GOOGLE SHEETS API CLIENT
 *
 * Direct integration with Google Sheets API v4 using API key authentication.
 * Supports reading spreadsheet data, metadata inspection, and mapping rows
 * into Villa-OS CRM leads or pricing sheets.
 */

import type { KycStatus, Lead, LeadSource, LeadStatus } from "../crm/types";

const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

export function googleSheetsApiKey(): string | undefined {
  return process.env.GOOGLE_SHEETS_API_KEY?.trim();
}

export function isGoogleSheetsConfigured(): boolean {
  return Boolean(googleSheetsApiKey());
}

/**
 * Extracts a spreadsheet ID from a full Google Sheets URL or returns the input if already an ID.
 */
export function extractSpreadsheetId(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return trimmed;
}

export interface SheetMetadata {
  spreadsheetId: string;
  title: string;
  locale?: string;
  timeZone?: string;
  sheets: Array<{
    sheetId: number;
    title: string;
    index: number;
    rowCount?: number;
    columnCount?: number;
  }>;
}

export interface SheetValuesResult {
  range: string;
  majorDimension: string;
  values: string[][];
}

export interface GoogleSheetsStatusResult {
  configured: boolean;
  valid: boolean;
  message: string;
  error?: string;
}

/**
 * Verifies API key validity against Google Sheets API v4.
 */
export async function checkGoogleSheetsStatus(): Promise<GoogleSheetsStatusResult> {
  const key = googleSheetsApiKey();
  if (!key) {
    return {
      configured: false,
      valid: false,
      message: "GOOGLE_SHEETS_API_KEY is not set in .env.local",
    };
  }

  try {
    const res = await fetch(`${SHEETS_BASE_URL}/__villa_os_probe_id__?key=${key}`, {
      method: "GET",
      cache: "no-store",
    });

    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: number; message?: string; status?: string };
    };

    if (res.status === 404 || json.error?.code === 404 || json.error?.status === "NOT_FOUND") {
      return {
        configured: true,
        valid: true,
        message: "Google Sheets API key is verified and active (Sheets API v4 enabled).",
      };
    }

    if (!res.ok) {
      return {
        configured: true,
        valid: false,
        message: json.error?.message || `Google Sheets API responded with HTTP ${res.status}`,
        error: json.error?.status || `HTTP_${res.status}`,
      };
    }

    return {
      configured: true,
      valid: true,
      message: "Google Sheets API is reachable and authorized.",
    };
  } catch (err) {
    return {
      configured: true,
      valid: false,
      message: err instanceof Error ? err.message : String(err),
      error: "NETWORK_ERROR",
    };
  }
}

/**
 * Retrieves metadata for a spreadsheet.
 */
export async function getSpreadsheetMetadata(spreadsheetIdOrUrl: string): Promise<SheetMetadata> {
  const key = googleSheetsApiKey();
  if (!key) throw new Error("GOOGLE_SHEETS_API_KEY is not configured");

  const id = extractSpreadsheetId(spreadsheetIdOrUrl);
  const res = await fetch(`${SHEETS_BASE_URL}/${id}?key=${key}`, {
    method: "GET",
    cache: "no-store",
  });

  const json = (await res.json()) as {
    properties?: { title?: string; locale?: string; timeZone?: string };
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        index?: number;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(json.error?.message || `Failed to fetch spreadsheet metadata (HTTP ${res.status})`);
  }

  return {
    spreadsheetId: id,
    title: json.properties?.title || "Untitled Spreadsheet",
    locale: json.properties?.locale,
    timeZone: json.properties?.timeZone,
    sheets: (json.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? "Sheet1",
      index: s.properties?.index ?? 0,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
    })),
  };
}

/**
 * Reads row values from a spreadsheet range (e.g. "Sheet1!A1:Z50" or "A1:G").
 */
export async function readSheetValues(
  spreadsheetIdOrUrl: string,
  range: string = "A1:Z100",
): Promise<SheetValuesResult> {
  const key = googleSheetsApiKey();
  if (!key) throw new Error("GOOGLE_SHEETS_API_KEY is not configured");

  const id = extractSpreadsheetId(spreadsheetIdOrUrl);
  const encodedRange = encodeURIComponent(range);
  const res = await fetch(`${SHEETS_BASE_URL}/${id}/values/${encodedRange}?key=${key}`, {
    method: "GET",
    cache: "no-store",
  });

  const json = (await res.json()) as {
    range?: string;
    majorDimension?: string;
    values?: string[][];
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(json.error?.message || `Failed to read spreadsheet values (HTTP ${res.status})`);
  }

  return {
    range: json.range || range,
    majorDimension: json.majorDimension || "ROWS",
    values: json.values ?? [],
  };
}

/**
 * Maps 2D table values into normalized Villa-OS CRM leads.
 */
export function parseLeadsFromSheet(
  rows: string[][],
  brandId = "brand_glentree",
): Array<Omit<Lead, "id" | "createdAt" | "updatedAt">> {
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const nameIdx = headers.findIndex((h) => h.includes("name") || h.includes("customer") || h.includes("lead"));
  const phoneIdx = headers.findIndex((h) => h.includes("phone") || h.includes("mobile") || h.includes("contact"));
  const emailIdx = headers.findIndex((h) => h.includes("email"));
  const cityIdx = headers.findIndex((h) => h.includes("city") || h.includes("location"));
  const budgetMinIdx = headers.findIndex((h) => h.includes("budget min") || h.includes("min budget") || h === "min");
  const budgetMaxIdx = headers.findIndex((h) => h.includes("budget max") || h.includes("max budget") || h === "max");
  const singleBudgetIdx = headers.findIndex((h) => (h === "budget" || h.includes("budget band") || h.includes("price")) && !h.includes("min") && !h.includes("max"));
  const stageIdx = headers.findIndex((h) => h.includes("stage") || h.includes("status"));
  const sourceIdx = headers.findIndex((h) => h.includes("source") || h.includes("channel"));
  const notesIdx = headers.findIndex((h) => h.includes("note") || h.includes("remark") || h.includes("comment"));

  const leads: Array<Omit<Lead, "id" | "createdAt" | "updatedAt">> = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !c || !c.trim())) continue;

    const name = (nameIdx >= 0 ? row[nameIdx] : "") || `Lead ${r}`;
    const phone = (phoneIdx >= 0 ? row[phoneIdx] : "") || "";
    const email = (emailIdx >= 0 ? row[emailIdx] : "") || undefined;
    const city = (cityIdx >= 0 ? row[cityIdx] : "") || "Hyderabad";

    const rawStage = (stageIdx >= 0 ? row[stageIdx]?.toLowerCase().trim() : "") || "new";
    let status: LeadStatus = "new";
    if (rawStage.includes("visit")) status = "site_visit_scheduled";
    else if (rawStage.includes("contact")) status = "contacted";
    else if (rawStage.includes("negotiat")) status = "negotiation";
    else if (rawStage.includes("token")) status = "booking_token_paid";
    else if (rawStage.includes("won") || rawStage.includes("close")) status = "won";
    else if (rawStage.includes("lost")) status = "lost";


    const rawSource = (sourceIdx >= 0 ? row[sourceIdx]?.toLowerCase().trim() : "") || "website";
    const validSources: LeadSource[] = [
      "meta_ads",
      "google_ads",
      "instagram",
      "facebook",
      "whatsapp",
      "portal_99acres",
      "portal_magicbricks",
      "portal_housing",
      "referral",
      "broker",
      "walk_in",
      "website",
    ];
    const source: LeadSource = validSources.find((s) => s === rawSource) || "website";

    const notes = notesIdx >= 0 ? row[notesIdx] : undefined;

    let min = 15000000;
    let max = 30000000;

    if (budgetMinIdx >= 0 && row[budgetMinIdx]) {
      const parsedMin = parseInt(row[budgetMinIdx].replace(/[^0-9]/g, ""), 10);
      if (!isNaN(parsedMin) && parsedMin > 0) min = parsedMin;
    }

    if (budgetMaxIdx >= 0 && row[budgetMaxIdx]) {
      const parsedMax = parseInt(row[budgetMaxIdx].replace(/[^0-9]/g, ""), 10);
      if (!isNaN(parsedMax) && parsedMax > 0) max = parsedMax;
    } else if (singleBudgetIdx >= 0 && row[singleBudgetIdx]) {
      const parsed = parseInt(row[singleBudgetIdx].replace(/[^0-9]/g, ""), 10);
      if (!isNaN(parsed) && parsed > 0) {
        min = Math.round(parsed * 0.85);
        max = Math.round(parsed * 1.15);
      }
    }

    if (max < min) max = min * 1.5;

    leads.push({
      brandId,
      name,
      phone,
      email,
      city,
      status,
      budgetMin: min,
      budgetMax: max,
      source,
      projectInterest: "Glentree Estate",
      unitType: "4BHK Villa",
      assignedTo: "unassigned",
      score: 60,
      isHNWI: min >= 50000000,
      kycStatus: "pending" as KycStatus,
      notes,
      tags: ["google_sheets_import"],
    });
  }

  return leads;
}
