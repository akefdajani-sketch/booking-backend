// Patch script - run from your booking-backend root
// node patch_invites.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'routes/tenantUsers/invites.js');

if (!fs.existsSync(filePath)) {
  console.error('ERROR: Could not find routes/tenantUsers/invites.js');
  console.error('Make sure you run this from the booking-backend root directory.');
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf8');

// Check if already patched
if (content.includes('const ALLOWED_ROLES')) {
  console.log('✅ Already patched — ALLOWED_ROLES already defined. Nothing to do.');
  process.exit(0);
}

// Insert ALLOWED_ROLES after the last require/import block
// Find the last require line
const requirePattern = /^(const|var|let)\s+\S+\s*=\s*require\(.+\);?\s*$/m;
const lines = content.split('\n');

let lastRequireLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^\s*(const|var|let)\s+\S+\s*=\s*require\(/.test(lines[i])) {
    lastRequireLine = i;
  }
}

const insertion = `\n// Valid roles for tenant team members\nconst ALLOWED_ROLES = ['owner', 'admin', 'staff'];\n`;

if (lastRequireLine === -1) {
  // No require found, prepend at top
  content = insertion + content;
} else {
  lines.splice(lastRequireLine + 1, 0, insertion);
  content = lines.join('\n');
}

// Backup original
fs.writeFileSync(filePath + '.bak', fs.readFileSync(filePath));
console.log(`📦 Backup saved to: ${filePath}.bak`);

fs.writeFileSync(filePath, content, 'utf8');
console.log('✅ Patch applied — ALLOWED_ROLES inserted into invites.js');
console.log('🚀 Redeploy your backend on Render to apply the fix.');
