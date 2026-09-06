const fs = require('fs');

const file = 'src/app/api/ops/session/route.ts';
let content = fs.readFileSync(file, 'utf8');

const rateLimitCode = `
const rateLimit = new Map<string, { count: number; time: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimit.get(ip) ?? { count: 0, time: now };
  if (now - entry.time > 60000) {
    entry.count = 1;
    entry.time = now;
  } else {
    entry.count += 1;
  }
  rateLimit.set(ip, entry);
  return entry.count > 5;
}
`;

if (!content.includes('isRateLimited')) {
  content = content.replace('export async function GET', rateLimitCode + '\nexport async function GET');
  content = content.replace('export async function GET() {', 'export async function GET(req: Request) {\n  const ip = req.headers.get("x-forwarded-for") ?? "unknown";\n  if (isRateLimited(ip)) return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });');
  fs.writeFileSync(file, content);
  console.log('Rate limit added.');
}
