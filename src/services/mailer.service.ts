import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let transporter: Transporter | null = null;

function getTransport(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.brevoSmtpHost,
      port: env.brevoSmtpPort,
      secure: env.brevoSmtpPort === 465,
      auth: { user: env.brevoSmtpUser, pass: env.brevoSmtpPass },
    });
  }
  return transporter;
}

/** Send an email via Brevo SMTP. Throws on failure (caller decides the response). */
export async function sendMail(opts: { to: string; subject: string; html: string }): Promise<void> {
  if (!env.brevoSmtpUser || !env.brevoSmtpPass) {
    logger.error('sendMail skipped: BREVO_SMTP_USER / BREVO_SMTP_PASS not configured');
    throw new Error('Email service not configured');
  }
  await getTransport().sendMail({ from: env.brevoFrom, ...opts });
}
