export type Email = { to: string; subject: string; text: string };

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  async send(email: Email): Promise<void> {
    if (process.env.NODE_ENV === 'production') return;
    const text = email.text.replace(/([?&](?:reset|verify|confirm-email)=)[A-Za-z0-9_-]+/g, '$1[REDACTED]');
    console.info('Email (authentication tokens redacted):', { ...email, text });
  }
}

export class BrevoMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(email: Email): Promise<void> {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: this.from },
        to: [{ email: email.to }],
        subject: email.subject,
        textContent: email.text,
      }),
    });
    if (!response.ok) throw new Error(`Brevo email request failed with status ${response.status}`);
  }
}

class DisabledMailer implements Mailer {
  async send(_email: Email): Promise<void> {}
}

let productionKeyWarningLogged = false;

export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const production = env.NODE_ENV === 'production';
  const apiKey = env.MAIL_API_KEY?.trim();
  if (production && !apiKey) {
    if (!productionKeyWarningLogged) {
      console.warn('MAIL_API_KEY is not configured; authentication emails are disabled.');
      productionKeyWarningLogged = true;
    }
    return new DisabledMailer();
  }

  const provider = env.MAIL_PROVIDER ?? (production ? 'brevo' : 'console');
  if (provider === 'console') {
    if (production) throw new Error('The console mail provider cannot be used in production');
    return new ConsoleMailer();
  }
  if (provider !== 'brevo') throw new Error('MAIL_PROVIDER must be "brevo" or "console"');
  if (!apiKey) throw new Error('MAIL_API_KEY is required when MAIL_PROVIDER=brevo');
  const from = env.MAIL_FROM?.trim();
  if (!from) throw new Error('MAIL_FROM is required when MAIL_PROVIDER=brevo');
  return new BrevoMailer(apiKey, from);
}
