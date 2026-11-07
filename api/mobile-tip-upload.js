'use strict';
// Copy this file and _lib/mobile-tip-upload.js to the existing website checkout.
// Existing _lib/tip-backend holds the server-side signed relay; do not copy its
// credentials into the mobile app or introduce new service-account credentials.
const { callTipBackend } = require('./_lib/tip-backend');
const { createMobileTipUploadHandler } = require('./_lib/mobile-tip-upload.js');
module.exports = createMobileTipUploadHandler({ callTipBackend });
