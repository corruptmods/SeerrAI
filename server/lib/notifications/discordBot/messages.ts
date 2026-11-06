import { defineMessages } from '@server/i18n';

/**
 * The Discord bot's own words; Approve, Decline and what a press did are
 * shared with ntfy and Telegram (requestActionMessages).
 */
const discordBotMessages = defineMessages('notifications.discordBot', {
  notLinked:
    'You can’t approve requests here: this Discord account isn’t linked to a {applicationTitle} account that can manage requests',
  severalAccounts:
    'You can’t approve requests here: this Discord account is linked to more than one {applicationTitle} account that can manage requests',
  declineTitle: 'Decline Request',
  declineReason: 'Reason (optional)',
  testTitle: 'Test message from {applicationTitle}',
  alreadyApprovedBy: 'Already approved by {userName}',
  alreadyDeclinedBy: 'Already declined by {userName}',
  notHere:
    'These buttons only work on {applicationTitle}’s own messages in its chosen server',
  testMessage:
    'Requests waiting for approval will look like this. These buttons are only a test: pressing them changes nothing.',
  testPressed: 'This is a test, so nothing changed.',
  testLinked:
    'This Discord account can approve requests as {userName} in {applicationTitle}.',
});

export default discordBotMessages;
