import { PROJECT_BRANCH, PROJECT_REPO } from '@server/constants/project';
import type { NotificationAgentEmail } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import Email from 'email-templates';
import net from 'node:net';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { URL } from 'url';
import { openpgpEncrypt } from './openpgpEncrypt';

// Light logo for the dark email background. PNG: Gmail and Outlook don't render
// SVG.
const LOGO_FILE = 'logo_ai_dark.png';
const PUBLIC_LOGO_URL = `https://raw.githubusercontent.com/${PROJECT_REPO}/${PROJECT_BRANCH}/public/${LOGO_FILE}`;

/**
 * Email logo URL: the repository copy if `usePublicLogo`, else this server's
 * (needs Application URL); undefined shows the app name. Test emails pass
 * their unsaved settings.
 */
export const emailLogoUrl = (
  options: Pick<
    NotificationAgentEmail['options'],
    'usePublicLogo'
  > = getSettings().notifications.agents.email.options
): string | undefined => {
  if (options.usePublicLogo) {
    return PUBLIC_LOGO_URL;
  }
  const { applicationUrl } = getSettings().main;
  return applicationUrl ? `${applicationUrl}/${LOGO_FILE}` : undefined;
};

const getSocket: SMTPTransport.Options['getSocket'] = (options, callback) => {
  if (!options.host || typeof options.port !== 'number') {
    callback(new Error('SMTP host and port are required'), undefined);
    return;
  }

  const socket = net.connect({
    host: options.host,
    port: options.port,
  });
  const cleanup = () => {
    socket.setTimeout(0);
    socket.removeListener('error', onError);
    socket.removeListener('connect', onConnect);
    socket.removeListener('timeout', onTimeout);
  };
  const onError = (error: Error) => {
    cleanup();
    callback(error, undefined);
  };
  const onConnect = () => {
    cleanup();
    callback(null, { connection: socket });
  };
  const onTimeout = () => {
    cleanup();
    socket.destroy();
    callback(new Error('SMTP connection timed out'), undefined);
  };

  socket.once('error', onError);
  socket.once('connect', onConnect);
  socket.once('timeout', onTimeout);
  socket.setTimeout(10000);
};

class PreparedEmail extends Email {
  public constructor(settings: NotificationAgentEmail, pgpKey?: string) {
    const { applicationUrl } = getSettings().main;

    const transport = nodemailer.createTransport({
      name: applicationUrl ? new URL(applicationUrl).hostname : undefined,
      host: settings.options.smtpHost,
      port: settings.options.smtpPort,
      secure: settings.options.secure,
      ignoreTLS: settings.options.ignoreTls,
      requireTLS: settings.options.requireTls,
      tls: settings.options.allowSelfSigned
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
      auth:
        settings.options.authUser && settings.options.authPass
          ? {
              user: settings.options.authUser,
              pass: settings.options.authPass,
            }
          : undefined,
      getSocket: net.isIP(settings.options.smtpHost) ? undefined : getSocket,
    });

    if (pgpKey) {
      transport.use(
        'stream',
        openpgpEncrypt({
          signingKey: settings.options.pgpPrivateKey,
          password: settings.options.pgpPassword,
          encryptionKeys: [pgpKey],
        })
      );
    }

    super({
      message: {
        from: {
          name: settings.options.senderName,
          address: settings.options.emailFrom,
        },
      },
      send: true,
      // email-templates types target @types/nodemailer 8; nodemailer 10's
      // transporter is the same at run time (only sendMail is called).
      transport: transport as unknown as Email.NodeMailerTransportOptions,
      preview: false,
    });
  }
}

export default PreparedEmail;
