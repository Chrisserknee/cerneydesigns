const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'functions-selects', '_shared');
fs.mkdirSync(destination, { recursive: true });
for (const file of ['storage.js', 'gateway.js', 'logos-gateway.js', 'logos.js', 'moderation.js', 'providers.js', 'emails.js', 'member-extras.js', 'member-billing.js', 'member-billing-provider.js']) {
    fs.copyFileSync(path.join(root, 'functions-spotlight', file), path.join(destination, file));
}
console.log('Prepared shared Cerney Selects workflow sources.');
