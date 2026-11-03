// Shared with the interactive login command; never source user shell profiles.
export const agentPathSetup = `export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.volta/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$node_bin/node" ]; then export PATH="$node_bin:$PATH"; fi
  done
fi`;
