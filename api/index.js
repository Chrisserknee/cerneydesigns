// Vercel serverless function handler
const serverless = require('serverless-http');
const app = require('../server');

// Wrap Express app with serverless-http for Vercel
module.exports = serverless(app);

