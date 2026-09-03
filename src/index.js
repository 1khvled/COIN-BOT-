/**
 * index.js — Application entry point
 */

require('dotenv').config();

const db = require('./db');
const { createBot } = require('./bot');
const scheduler = require('./scheduler');

// Validate env
const required = ['BOT_TOKEN', 'ADMIN_CHAT_ID', 'ENCRYPT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  console.error('   Copy .env.example → .env and fill in values.');
  process.exit(1);
}

async function main() {
  console.log('\n🤖 AliExpress Coin Collector Bot — Starting...\n');

  await db.init();
  console.log('✅ Database ready');

  const bot = createBot();
  console.log('✅ Bot polling active');

  scheduler.initScheduler();
  console.log('✅ Scheduler active');

  // Missed-run catch-up: if the PC was off at the scheduled time,
  // collect as soon as the bot starts (once per day).
  if (scheduler.shouldCatchUp()) {
    console.log('⏰ Scheduled time already passed and nothing collected today — running catch-up...');
    scheduler
      .runAllCollections()
      .then(() => console.log('✅ Catch-up collection complete.'))
      .catch((err) => console.error('💥 Catch-up collection failed:', err.message));
  }

  console.log(`\n   Admin: ${process.env.ADMIN_CHAT_ID}`);
  console.log(`   Multi-user: ${process.env.MULTI_USER === 'true' ? 'ON' : 'OFF'}`);
  console.log(`   TZ: ${process.env.TZ || 'UTC'}`);
  console.log('\n🟢 Bot running! Send /start in Telegram.\n');

  // Graceful shutdown
  function shutdown(sig) {
    console.log(`\n⏹ ${sig} — shutting down...`);
    bot.stopPolling();
    db.close();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});

process.on('uncaughtException', (e) => console.error('💥 Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('💥 Rejection:', e));
