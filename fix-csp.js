const fs = require('fs');

const file = 'src/middleware.ts';
let content = fs.readFileSync(file, 'utf8');

if (!content.includes('requestHeaders.set("Content-Security-Policy"')) {
  content = content.replace(
    'requestHeaders.set("x-nonce", nonce);',
    'requestHeaders.set("x-nonce", nonce);\n  requestHeaders.set("Content-Security-Policy", securityHeaders(nonce, isDev)["Content-Security-Policy"]);'
  );
  fs.writeFileSync(file, content);
  console.log('CSP request header added.');
}
