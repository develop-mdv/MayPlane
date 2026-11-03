import { assert, q } from './security.mjs';
import { agentPathSetup } from '../lib/agent-path.mjs';

// Non-interactive SSH does not load .bashrc. Resolve standard user installs
// without executing arbitrary login/profile scripts or requiring system-wide links.
export const openCodeInstall = `set -eu
${agentPathSetup}
# Keep an existing installation and running services untouched. Updating is a
# separate, explicit action; installation is safe to retry after a lost response.
if command -v opencode >/dev/null 2>&1 && opencode --version; then
  printf 'OpenCode уже установлен: %s\\n' "$(command -v opencode)"
  exit 0
fi
command -v curl >/dev/null 2>&1 || { echo 'Для установки OpenCode нужен curl. Установите curl и повторите.' >&2; exit 1; }
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-time 60 https://opencode.ai/install -o "$installer"
bash "$installer" --no-modify-path
"$HOME/.opencode/bin/opencode" --version`;

export function posixAgentCommand(
  provider,
  operation,
  args,
  cwd,
  executableOverride,
) {
  assert(['codex', 'opencode'].includes(provider), 'Неизвестный агент');
  const prefix = `${agentPathSetup}\n${cwd ? `cd ${q(cwd)} || exit 1\n` : ''}`;
  if (provider === 'opencode' && operation === 'install')
    return prefix + openCodeInstall;
  const executable =
    operation === 'install' ? 'npm' : executableOverride || provider;
  const invocation =
    operation === 'install'
      ? `npm install --global --prefix "$HOME/.local" ${q('@openai/codex')}`
      : [executable, ...args].map(q).join(' ');
  return `${prefix}exec ${provider === 'opencode' ? `env OPENCODE_PERMISSION=${q(JSON.stringify({ '*': 'ask' }))} ` : ''}${invocation}`;
}
