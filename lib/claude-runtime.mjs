import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

export const claudeAcpVersion = '0.100.0';
export const claudeAcpPackage = `@agentclientprotocol/claude-agent-acp@${claudeAcpVersion}`;
export { isClaudeSubscription } from './claude-auth.mjs';
export function claudeAdapterEntry(home = os.homedir()) {
  return join(
    home,
    '.mayplane',
    'agents',
    'claude',
    `acp-${claudeAcpVersion}`,
    'node_modules',
    '@agentclientprotocol',
    'claude-agent-acp',
    'dist',
    'index.js',
  );
}
export function localClaudeCommand(
  operation,
  args,
  {
    home = os.homedir(),
    platform = process.platform,
    node = process.execPath,
  } = {},
) {
  const entry = claudeAdapterEntry(home);
  if (operation === 'agent' || operation === 'adapter-version')
    return { executable: node, args: [entry, ...args] };
  if (existsSync(entry))
    return { executable: node, args: [entry, '--cli', ...args] };
  const native = join(
    home,
    '.local',
    'bin',
    platform === 'win32' ? 'claude.exe' : 'claude',
  );
  if (existsSync(native)) return { executable: native, args };
  // The ACP release bundles Anthropic's native Claude Code executable.
  return { executable: node, args: [entry, '--cli', ...args] };
}
export function claudeLoginUrl(output) {
  // Terminal escape bytes delimit OSC hyperlinks; never include them in a login URL.
  for (const match of output.matchAll(
    // eslint-disable-next-line no-control-regex
    /https:\/\/[^\s<>"\x1b]+(?=[\s<>"\x1b])/g,
  )) {
    try {
      const url = new URL(match[0]);
      if (
        [
          'claude.ai',
          'claude.com',
          'console.anthropic.com',
          'platform.claude.com',
        ].includes(url.hostname) &&
        url.pathname.endsWith('/oauth/authorize') &&
        !url.username &&
        !url.password &&
        url.href.length <= 8192 &&
        url.searchParams.has('client_id') &&
        url.searchParams.has('code_challenge') &&
        url.searchParams.has('state')
      )
        return url.href;
    } catch {}
  }
  return null;
}
