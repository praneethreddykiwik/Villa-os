const fs = require('fs');
const { execSync } = require('child_process');

const files = execSync('grep -rl "db.brands\\[0\\]" src/app/api').toString().trim().split('\n');
let patched = 0;

for (const file of files) {
  if (!file) continue;
  let content = fs.readFileSync(file, 'utf8');

  if (content.includes('assertBrandAccess')) continue;

  const regex = /(const|let)\s+brandId\s*=\s*(?:db\.brands\[0\]\?\.id\s*\|\|\s*"[^"]+"|.*db\.brands\[0\].*);/g;
  
  content = content.replace(regex, (match) => {
    return `${match}
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }`;
  });

  if (content !== fs.readFileSync(file, 'utf8')) {
    fs.writeFileSync(file, content);
    patched++;
    console.log("Patched", file);
  }
}
console.log("Total patched:", patched);
