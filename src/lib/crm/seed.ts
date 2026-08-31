import { addDays, id, isoDay, makeRng } from "../ids";
import { diff, evaluate, scoreLead } from "./rules";
import type { Broker, CrmContact, CrmTask, Lead, LeadSource, LeadStatus, Transaction } from "./types";

/**
 * CRM seed for the real-estate brand.
 *
 * Engineered, not random: the pipeline has a realistic funnel shape (many new,
 * few won), several leads are deliberately stale so the re-engage rule fires,
 * some have site visits both upcoming and just-past so both visit rules fire,
 * and a few tokens are paid so the agreement/registration chain appears in
 * follow-ups. Random data would leave half the rules engine untested.
 */

const rng = makeRng(776211);
const CR = 1e7;

const FIRST = ["Aarav", "Vivaan", "Aditya", "Kabir", "Rohan", "Ishaan", "Ananya", "Diya", "Meera", "Kavya", "Rhea", "Nikhil", "Arjun", "Siddharth", "Priya", "Neha", "Rajesh", "Sunita", "Vikram", "Anjali", "Farhan", "Zara", "Karan", "Tanvi"];
const LAST = ["Mehta", "Shah", "Kapoor", "Reddy", "Iyer", "Nair", "Malhotra", "Chopra", "Agarwal", "Bhatt", "Desai", "Rao", "Sethi", "Khanna", "Joshi", "Verma"];
const CITIES = ["Mumbai", "Pune", "Bengaluru", "Delhi NCR", "Hyderabad", "Dubai", "Singapore", "London"];
const OCCUPATIONS = ["Founder", "Managing Director", "Surgeon", "Investment Banker", "Partner — Law Firm", "CXO", "NRI Investor", "Film Producer", "Textile Exporter", "Fund Manager"];

const PROJECTS = [
  { name: "Aurum Skyline — Worli", units: ["3BHK Sky Residence", "4BHK Sky Residence", "Duplex Penthouse"], min: 6.5 * CR, max: 24 * CR },
  { name: "Aurum Gardens — Bandra", units: ["2BHK Garden", "3BHK Garden", "4BHK Terrace"], min: 3.2 * CR, max: 9.5 * CR },
  { name: "Aurum Enclave — Alibaug", units: ["Villa 4BHK", "Villa 5BHK", "Sea-face Villa"], min: 4.8 * CR, max: 18 * CR },
  { name: "Aurum One — Lower Parel", units: ["1BHK Studio", "2BHK Signature", "3BHK Signature"], min: 1.2 * CR, max: 4.5 * CR },
];

const SOURCES: LeadSource[] = [
  "instagram", "instagram", "meta_ads", "meta_ads", "google_ads", "whatsapp", "whatsapp",
  "portal_99acres", "portal_99acres", "portal_magicbricks", "portal_housing",
  "referral", "referral", "broker", "broker", "broker", "walk_in", "website", "facebook",
];

// Funnel weights: a healthy pipeline is bottom-light, not evenly distributed.
const STATUS_MIX: LeadStatus[] = [
  ...Array<LeadStatus>(16).fill("new"),
  ...Array<LeadStatus>(14).fill("contacted"),
  ...Array<LeadStatus>(9).fill("site_visit_scheduled"),
  ...Array<LeadStatus>(7).fill("negotiation"),
  ...Array<LeadStatus>(4).fill("booking_token_paid"),
  ...Array<LeadStatus>(5).fill("won"),
  ...Array<LeadStatus>(6).fill("lost"),
];

const RMS = ["Ritu Sharma", "Kunal Bose", "Farida Merchant", "Aman Gill"];
const LOST_REASONS = ["Bought from a competitor", "Budget mismatch after final quote", "Loan not sanctioned", "Postponed to next FY", "Wanted possession sooner", "Location did not suit family"];

export interface CrmSeed {
  brokers: Broker[];
  leads: Lead[];
  contacts: CrmContact[];
  tasks: CrmTask[];
}

export function buildCrm(brandId: string, today: Date): CrmSeed {
  const brokers = buildBrokers(brandId);
  const contacts: CrmContact[] = [];
  const leads: Lead[] = [];

  for (let i = 0; i < STATUS_MIX.length; i++) {
    const status = STATUS_MIX[i];
    const project = rng.pick(PROJECTS);
    const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    const source = rng.pick(SOURCES);
    const broker = source === "broker" ? rng.pick(brokers) : undefined;

    // Budget band sits around the project's range, widened by the buyer's own spread.
    const centre = rng.float(project.min, project.max);
    const spread = centre * rng.float(0.12, 0.3);
    const budgetMin = Math.round((centre - spread) / 1e5) * 1e5;
    const budgetMax = Math.round((centre + spread) / 1e5) * 1e5;
    const isHNWI = budgetMax >= 8 * CR;

    // Older leads sit deeper in the funnel — a token paid yesterday by a lead
    // created yesterday would be a fiction.
    const ageDays =
      status === "new" ? rng.int(0, 6)
      : status === "contacted" ? rng.int(3, 30)
      : status === "site_visit_scheduled" ? rng.int(10, 45)
      : status === "negotiation" ? rng.int(25, 80)
      : rng.int(45, 150);

    const createdAt = addDays(today, -ageDays);
    // Deliberately leave a slice of "contacted" leads stale so the re-engage rule fires.
    const quiet = status === "contacted" && i % 4 === 0 ? rng.int(9, 22) : rng.int(0, 5);
    const lastContactedAt = status === "new" && i % 3 === 0 ? undefined : addDays(today, -Math.min(ageDays, quiet));

    // Half the scheduled visits are upcoming, half just past — both rules fire.
    const siteVisitAt =
      status === "site_visit_scheduled"
        ? addDays(today, i % 2 === 0 ? rng.int(1, 9) : -rng.int(1, 4))
        : ["negotiation", "booking_token_paid", "won"].includes(status)
          ? addDays(today, -rng.int(10, 40))
          : undefined;

    const tokenPaidAt = ["booking_token_paid", "won"].includes(status) ? addDays(today, -rng.int(3, 40)) : undefined;

    const lead: Lead = {
      id: id("lead"),
      brandId,
      name,
      phone: `+91 ${rng.int(70, 99)}${rng.int(10000000, 99999999)}`.slice(0, 17),
      email: `${name.split(" ")[0].toLowerCase()}.${name.split(" ")[1].toLowerCase()}@example.com`,
      city: rng.pick(CITIES),
      status,
      budgetMin,
      budgetMax,
      source,
      brokerId: broker?.id,
      projectInterest: project.name,
      unitType: rng.pick(project.units),
      assignedTo: rng.pick(RMS),
      score: 0,
      isHNWI,
      kycStatus:
        status === "won" ? "verified"
        : status === "booking_token_paid" ? (i % 3 === 0 ? "pending" : "verified")
        : status === "negotiation" ? (i % 2 === 0 ? "pending" : "not_started")
        : "not_started",
      notes: undefined,
      createdAt: createdAt.toISOString(),
      updatedAt: addDays(today, -rng.int(0, 3)).toISOString(),
      lastContactedAt: lastContactedAt?.toISOString(),
      siteVisitAt: siteVisitAt?.toISOString(),
      tokenPaidAt: tokenPaidAt?.toISOString(),
      wonAt: status === "won" ? addDays(today, -rng.int(1, 30)).toISOString() : undefined,
      lostReason: status === "lost" ? rng.pick(LOST_REASONS) : undefined,
      tags: [
        ...(isHNWI ? ["hnwi"] : []),
        ...(["Dubai", "Singapore", "London"].includes(rng.pick(CITIES)) ? [] : []),
        project.name.split(" — ")[1].toLowerCase(),
      ],
    };
    lead.score = scoreLead(lead, today.getTime());
    leads.push(lead);

    // Everyone who paid a token or closed becomes a contact record with money history.
    if (["booking_token_paid", "won"].includes(status)) {
      const contact = buildCustomer(brandId, lead, project, today);
      contacts.push(contact);
      lead.contactId = contact.id;
    }
  }

  // A handful of relationship-only contacts: past buyers and investors who are
  // not currently an open enquiry. A CRM that only holds live leads forgets the
  // people most likely to buy again.
  for (let i = 0; i < 8; i++) {
    const project = rng.pick(PROJECTS);
    const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    const fake: Lead = {
      ...leads[0],
      id: id("lead_ghost"),
      name,
      budgetMin: project.min,
      budgetMax: project.max,
      projectInterest: project.name,
      unitType: rng.pick(project.units),
      city: rng.pick(CITIES),
    };
    const c = buildCustomer(brandId, fake, project, addDays(today, -rng.int(200, 900)));
    c.type = i % 4 === 0 ? "investor" : "customer";
    contacts.push(c);
  }

  // Run the rules engine at seed time so the follow-ups page is populated on a
  // fresh install rather than showing an empty state that reads like a bug. This
  // is the same pure evaluate/diff the API uses, so seeded and generated tasks
  // are indistinguishable — and re-running the generator still creates nothing.
  const manual = buildManualTasks(brandId, leads, today);
  const generated = diff(
    evaluate({ leads, contacts, existing: manual, now: today.getTime() }),
    manual,
    brandId,
  );

  // Mark a few as already done so the list opens with a realistic mix rather
  // than a wall of untouched reminders.
  generated.forEach((t, i) => {
    if (i % 7 === 3) {
      t.status = "done";
      t.completedAt = addDays(today, -rng.int(1, 5)).toISOString();
    }
  });

  return { brokers, leads, contacts, tasks: [...manual, ...generated] };
}

function buildBrokers(brandId: string): Broker[] {
  const firms = [
    ["Rustom Vakil", "Vakil Realty"],
    ["Sneha Pillai", "Coastline Partners"],
    ["Imran Qureshi", "Qureshi Estates"],
    ["Deepak Rana", "Rana Property Advisors"],
    ["Alisha Fernandes", "Bay Realty"],
    ["Gopal Menon", "Menon & Sons"],
  ];
  return firms.map(([name, firm], i) => ({
    id: id("broker"),
    brandId,
    name,
    firm,
    phone: `+91 98${rng.int(10000000, 99999999)}`.slice(0, 16),
    reraId: `A5190000${1000 + i}`,
    commissionPct: Number(rng.float(1.0, 2.5).toFixed(2)),
    leadsReferred: rng.int(4, 38),
    dealsClosed: rng.int(0, 7),
    rating: Number(rng.float(3.2, 4.9).toFixed(1)),
    active: i !== 5,
  }));
}

function buildCustomer(
  brandId: string,
  lead: Lead,
  project: { name: string; units: string[] },
  today: Date,
): CrmContact {
  const dealValue = Math.round(((lead.budgetMin + lead.budgetMax) / 2 / 1e5)) * 1e5;
  const unit = `${rng.pick(["A", "B", "C"])}-${rng.int(4, 42)}0${rng.int(1, 4)}`;
  const contactId = id("contact");

  // The payment ladder for an Indian residential sale: token, then agreement
  // with stamp duty, then construction-linked installments, then registration.
  const ladder: Array<[Transaction["type"], number, number]> = [
    ["booking_token", 0.02, -rng.int(30, 120)],
    ["agreement", 0.18, -rng.int(10, 60)],
    ["installment", 0.25, -rng.int(2, 30)],
    ["installment", 0.25, rng.int(20, 60)],
    ["registration", 0.2, rng.int(60, 140)],
    ["final_payment", 0.1, rng.int(120, 260)],
  ];

  const transactions: Transaction[] = ladder.map(([type, pct, dayOffset], i) => {
    const date = addDays(today, dayOffset);
    const isPast = dayOffset < 0;
    return {
      id: id("txn"),
      contactId,
      project: project.name,
      unit,
      type,
      amount: Math.round((dealValue * pct) / 1000) * 1000,
      date: isoDay(date),
      // One overdue installment on purpose: the payment-chase path needs a subject.
      status: isPast ? (i === 2 && rng.bool(0.4) ? "overdue" : "paid") : "pending",
      mode: rng.pick(["neft", "rtgs", "cheque", "loan_disbursement"]) as Transaction["mode"],
      reference: `AUR/${new Date(date).getFullYear()}/${rng.int(10000, 99999)}`,
    };
  });

  const paid = transactions.filter((t) => t.status === "paid").reduce((a, t) => a + t.amount, 0);

  return {
    id: contactId,
    brandId,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    city: lead.city,
    type: "customer",
    hnwiTier: dealValue >= 15e7 ? "uhnwi" : dealValue >= 8e7 ? "hnwi" : dealValue >= 4e7 ? "affluent" : "none",
    netWorthBand: dealValue >= 15e7 ? "₹250 Cr+" : dealValue >= 8e7 ? "₹50 – 250 Cr" : "₹10 – 50 Cr",
    kycStatus: rng.bool(0.75) ? "verified" : "pending",
    kycDocs: rng.bool(0.75)
      ? ["PAN", "Aadhaar", "Address proof", "Bank statement"]
      : rng.pick([["PAN"], ["PAN", "Aadhaar"], ["PAN", "Address proof"]]),
    kycUpdatedAt: addDays(today, -rng.int(1, 90)).toISOString(),
    occupation: rng.pick(OCCUPATIONS),
    company: rng.bool(0.6) ? `${rng.pick(LAST)} Group` : undefined,
    preferredLanguage: rng.pick(["English", "English", "Hindi", "Marathi", "Gujarati"]),
    relationshipManager: lead.assignedTo,
    lifetimeValue: paid,
    tags: [lead.projectInterest.split(" — ")[1].toLowerCase(), ...(dealValue >= 8e7 ? ["hnwi"] : [])],
    createdAt: lead.createdAt,
    transactions,
  };
}

/** A few hand-created tasks so the list is not 100% machine-generated. */
function buildManualTasks(brandId: string, leads: Lead[], today: Date): CrmTask[] {
  const picks = leads.filter((l) => ["negotiation", "booking_token_paid"].includes(l.status)).slice(0, 5);
  const titles: Array<[string, CrmTask["type"], number]> = [
    ["Send revised payment plan", "document", 1],
    ["Arrange sample-flat walkthrough", "meeting", 2],
    ["Share floor plate PDF on WhatsApp", "whatsapp", 0],
    ["Loan pre-approval intro call", "call", 3],
    ["Confirm car-park allocation", "call", -1],
  ];
  return picks.map((lead, i) => {
    const [title, type, dueIn] = titles[i % titles.length];
    return {
      id: id("task"),
      brandId,
      title: `${title} — ${lead.name}`,
      type,
      dueAt: addDays(today, dueIn).toISOString(),
      status: "open" as const,
      assignedTo: lead.assignedTo,
      leadId: lead.id,
      priority: (dueIn < 0 ? "high" : "normal") as CrmTask["priority"],
      autoGenerated: false,
      createdAt: addDays(today, -rng.int(1, 8)).toISOString(),
    };
  });
}
