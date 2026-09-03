require('dotenv').config();

function checkSessionExpiry() {
  const validUntil = new Date(process.env.SESSION_VALID_UNTIL);
  const today = new Date();
  const daysLeft = Math.ceil((validUntil - today) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 0) {
    console.error(`\n⚠️  Enable Banking session EXPIRED on ${process.env.SESSION_VALID_UNTIL}. Redo the auth flow (start-auth.js → exchange-code.js) before syncing.\n`);
    process.exit(1);
  } else if (daysLeft <= 14) {
    console.warn(`\n⚠️  Enable Banking session expires in ${daysLeft} day(s) (${process.env.SESSION_VALID_UNTIL}). Plan to re-authorize soon.\n`);
  }
}

module.exports = { checkSessionExpiry };