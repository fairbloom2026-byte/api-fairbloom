const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sendOtpEmail(to, name, otp, expiryMinutes) {
  const key = process.env.BREVO_API_KEY;

  if (!key) {
    if (process.env.NODE_ENV === "production") throw new Error("Email is not configured");
    console.log(`[FairBloom] (DEV) OTP for ${to}: ${otp}`);
    return;
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "FairBloom", email: process.env.EMAIL_FROM_ADDRESS },
      to: [{ email: to, name }],
      subject: "Your FairBloom verification code",
      textContent:
        `Hi ${name},\n\nYour FairBloom verification code is: ${otp}\n\n` +
        `It expires in ${expiryMinutes} minutes. If you didn't sign up, you can ignore this email.`,
      htmlContent:
        `<p>Hi ${escapeHtml(name)},</p><p>Your FairBloom verification code is:</p>` +
        `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${otp}</p>` +
        `<p>It expires in ${expiryMinutes} minutes. If you didn't sign up, you can ignore this email.</p>`,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Brevo returned ${res.status}: ${await res.text()}`);
}

// Nothing to warm up with an HTTP API; kept so server.js doesn't need changes.
const warmUpEmail = () => {};

module.exports = { sendOtpEmail, warmUpEmail };
