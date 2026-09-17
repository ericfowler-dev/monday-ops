// Keep the email scripts' CommonJS entry point while sharing the calculations
// with the dashboard's browser bundle.
module.exports = require('./snap-dashboard/shared/movement-daily-core.cjs');
