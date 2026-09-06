const fs = require('fs');

const files = [
  'src/middleware.ts',
  'src/app/auth/callback/route.ts',
  'src/app/(auth)/signin/actions.ts',
  'src/lib/auth/session.ts',
  'src/lib/supabase/client.ts'
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  // we want to ensure c.options has { ...c.options, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" }
  content = content.replace(/c\.options/g, '{ ...c.options, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" }');
  if (content !== fs.readFileSync(file, 'utf8')) {
    fs.writeFileSync(file, content);
    console.log("Patched", file);
  }
}
