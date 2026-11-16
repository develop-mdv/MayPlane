import { assert, q } from './security.mjs';
import { agentPathSetup } from '../lib/agent-path.mjs';
import { posixProfileSetup } from './agent-profile.mjs';
import { claudeAcpPackage, claudeAcpVersion } from '../lib/claude-runtime.mjs';

export const claudeInstall = `set -eu
${agentPathSetup}
command -v curl >/dev/null 2>&1 || { echo 'Для установки Claude Code нужен curl' >&2;exit 1; }
umask 077
agent_root="$HOME/.mayplane/agents/claude"
mkdir -p "$agent_root" "$HOME/.local/bin"
if ! command -v claude >/dev/null 2>&1 || ! claude --version; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 90 https://claude.ai/install.sh -o "$installer"
  bash "$installer" </dev/null
fi
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  node_path=$(command -v node)
else
  case "$(uname -s)" in Linux) node_os=linux;; Darwin) node_os=darwin;; *) echo 'Поддерживаются Linux и macOS' >&2;exit 1;; esac
  case "$(uname -m)" in x86_64) node_arch=x64;; arm64|aarch64) node_arch=arm64;; *) echo 'Нужен x64 или arm64' >&2;exit 1;; esac
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT HUP INT TERM
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --max-time 90 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$work/sums"
  node_file=$(awk -v os="$node_os" -v arch="$node_arch" '$2 ~ ("^node-v24[.][0-9]+[.][0-9]+-" os "-" arch "[.]tar[.]gz$") {print $2;exit}' "$work/sums")
  [ -n "$node_file" ] || { echo 'Не найден официальный Node.js runtime' >&2;exit 1; }
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --max-time 180 "https://nodejs.org/dist/latest-v24.x/$node_file" -o "$work/$node_file"
  if command -v sha256sum >/dev/null 2>&1; then (cd "$work";grep -F " $node_file" sums | sha256sum --check --status);else (cd "$work";grep -F " $node_file" sums | shasum -a 256 -c);fi
  runtime="$agent_root/runtime/$node_file"
  mkdir -p "$runtime"
  tar -xzf "$work/$node_file" --strip-components=1 -C "$runtime"
  node_path="$runtime/bin/node"
fi
export PATH="$(dirname "$node_path"):$PATH"
adapter="$agent_root/acp-${claudeAcpVersion}"
npm install --prefix "$adapter" --no-save --ignore-scripts --include=optional --no-audit --no-fund ${q(claudeAcpPackage)}
wrapper="$HOME/.local/bin/claude-agent-acp"
{ printf '#!/bin/bash\\nexec ';printf '%q ' "$node_path" "$adapter/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";printf '"$@"\\n'; } > "$wrapper.tmp"
chmod 700 "$wrapper.tmp"
mv -f -- "$wrapper.tmp" "$wrapper"
"$wrapper" --version
claude --version
`;

export const codexInstall = `set -eu
${agentPathSetup}
command -v curl >/dev/null 2>&1 || { echo 'Для установки Codex нужен curl. Установите curl и повторите.' >&2; exit 1; }
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT HUP INT TERM
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 15 --max-time 60 https://chatgpt.com/codex/install.sh -o "$installer"
CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR="$HOME/.local/bin" sh "$installer" </dev/null
"$HOME/.local/bin/codex" --version`;

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
  profileId,
) {
  assert(
    ['codex', 'opencode', 'claude'].includes(provider),
    'Неизвестный агент',
  );
  const prefix = `${agentPathSetup}\n${cwd ? `cd ${q(cwd)} || exit 1\n` : ''}`;
  if (operation === 'install')
    return (
      prefix +
      (provider === 'codex'
        ? codexInstall
        : provider === 'claude'
          ? claudeInstall
          : openCodeInstall)
    );
  const invocation = [
    executableOverride ||
      (provider === 'claude' && ['agent', 'adapter-version'].includes(operation)
        ? 'claude-agent-acp'
        : provider),
    ...(profileId && provider === 'codex'
      ? ['-c', 'cli_auth_credentials_store="file"']
      : []),
    ...args,
  ]
    .map(q)
    .join(' ');
  return `${prefix}${profileId ? posixProfileSetup(provider, profileId) : ''}exec ${provider === 'opencode' ? `env OPENCODE_PERMISSION=${q(JSON.stringify({ '*': 'ask' }))} ` : provider === 'claude' && operation === 'login' ? 'env BROWSER=true ' : ''}${invocation}`;
}
