// Shared by the browser form and runner; keep this module free of Node APIs.
export const isClaudeSubscription = (account) =>
  !!account && ['claude.ai', 'oauth_token'].includes(account.type);
