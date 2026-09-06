const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const files = execSync('find src/app/api -name route.ts').toString().trim().split('\n');
let patched = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes('resolveBrandId')) continue;

  if (content.includes('assertBrandAccess')) continue; // already patched

  const regex = /(const|let)\s+brandId\s*=\s*resolveBrandId\([^;]+;/g;
  
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
