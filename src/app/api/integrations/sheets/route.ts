import { guard } from "@/lib/auth/guard";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { actorLabel, getSession } from "@/lib/auth/session";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { uid } from "@/lib/ids";
import { logActivity } from "@/lib/engine/publisher";
import {
  checkGoogleSheetsStatus,
  getSpreadsheetMetadata,
  isGoogleSheetsConfigured,
  parseLeadsFromSheet,
  readSheetValues,
} from "@/lib/sheets/client";
import type { Lead } from "@/lib/crm/types";

export async function GET(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const spreadsheetId = searchParams.get("spreadsheetId");
  const range = searchParams.get("range") || "A1:Z100";

  try {
    if (!spreadsheetId) {
      const status = await checkGoogleSheetsStatus();
      return apiOk({ ...status });
    }

    if (!isGoogleSheetsConfigured()) {
      return apiFail("GOOGLE_SHEETS_API_KEY is not configured.", 503);
    }

    const metadata = await getSpreadsheetMetadata(spreadsheetId);
    let values: string[][] = [];
    try {
      const valuesRes = await readSheetValues(spreadsheetId, range);
      values = valuesRes.values;
    } catch {
      // Swallowed if the range is invalid or sheet is empty
    }

    return apiOk({
      metadata,
      sampleValues: values.slice(0, 10),
      rowCount: values.length,
    });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  if (!isGoogleSheetsConfigured()) {
    return apiFail("GOOGLE_SHEETS_API_KEY is not configured in .env.local", 503);
  }

  try {
    const actor = actorLabel(await getSession());
    const body = (await req.json()) as {
      spreadsheetId?: string;
      range?: string;
      brandId?: string;
    };

    if (!body.spreadsheetId) {
      return apiFail("spreadsheetId or Google Sheets URL is required.", 400);
    }

    const range = body.range || "A1:Z200";
    const data = await readSheetValues(body.spreadsheetId, range);

    if (!data.values || data.values.length < 2) {
      return apiFail("No lead rows found in the specified sheet range.", 400);
    }

    const parsed = parseLeadsFromSheet(data.values);
    if (!parsed.length) {
      return apiFail("Could not parse any leads. Ensure the first row contains headers like Name, Phone, Email.", 400);
    }

    const db = read();
    const brandId = resolveBrandId(db, body.brandId);
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }
    const now = new Date().toISOString();

    const newLeads: Lead[] = parsed.map((p) => ({
      ...p,
      id: uid("lead"),
      createdAt: now,
      updatedAt: now,
    }));

    mutate((d) => {
      d.leads = [...(d.leads ?? []), ...newLeads];
    });

    logActivity(
      brandId,
      "crm",
      `Imported ${newLeads.length} lead(s) from Google Sheet ${body.spreadsheetId}`,
      actor,
    );

    return apiOk({
      importedCount: newLeads.length,
      leads: newLeads,
    });
  } catch (e) {
    return apiError(e);
  }
}
