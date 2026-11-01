let transporter = null;

function init(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return;
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      secure: Number(env.SMTP_PORT) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    console.log('[mailer] SMTP configured:', env.SMTP_HOST);
  } catch (e) {
    console.warn('[mailer] nodemailer not available:', e.message);
  }
}

async function sendPriceAlert(to, { jobId, changes, totalChanges }) {
  if (!transporter || !to) return;
  const rows = changes.slice(0, 20).map((c) => {
    const dir = c.pctChange < 0 ? 'down' : 'up';
    const sign = c.pctChange < 0 ? '' : '+';
    return `  ${c.productName}${c.vintage ? ' ' + c.vintage : ''} — ${c.vendor}: $${c.previousPrice} → $${c.price} (${sign}${c.pctChange}% ${dir})`;
  }).join('\n');

  const subject = `Fine Liquors: ${totalChanges} price change${totalChanges !== 1 ? 's' : ''} detected`;
  const text = [
    `Refresh job #${jobId} detected ${totalChanges} price change${totalChanges !== 1 ? 's' : ''}.`,
    '',
    'Significant changes:',
    rows,
    changes.length > 20 ? `  … and ${changes.length - 20} more` : '',
    '',
    'View the dashboard at http://localhost:5000/fine.html',
  ].filter((l) => l !== undefined).join('\n');

  await transporter.sendMail({ from: transporter.options.auth.user, to, subject, text });
  console.log(`[mailer] alert sent to ${to}`);
}

module.exports = { init, sendPriceAlert };
