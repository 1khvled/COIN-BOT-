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

  // No separate catch-up block: initScheduler arms the rolling 24h timer,
  // which sweeps immediately when overdue (late boot) and otherwise waits.
  // Every completed sweep re-anchors the clock, so it never runs twice.

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
