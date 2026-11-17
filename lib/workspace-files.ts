import type { Workspace } from './use-workspace';

export type WorkspaceApi = Workspace['api'];
export type FileEntry = { name: string; kind: 'directory' | 'file' };
export type DirectoryPage = {
  entries: FileEntry[];
  next: number | null;
  limited: boolean;
};
export type MachineDirectory = DirectoryPage & {
  path: string;
  parent: string | null;
  separator: string;
  selected?: string;
};
export type FilePreview = { size: number } & (
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'binary' }
);
export type Patch = { text: string; truncated: boolean };
type NoGit = { reason: 'no-git' | 'not-repo' };
export type GitFile = { path: string; oldPath?: string; status: string };
export type GitStatus = NoGit | { files: GitFile[]; limited: boolean };
export type GitPatch =
  | NoGit
  | { staged?: Patch; working?: Patch; untracked?: FilePreview };
export type ChangeTurn = {
  id: string;
  at: string;
  cwd: string;
  title?: string;
};
export type AgentEdit = {
  id: string;
  path: string;
  move?: string;
  kind: 'add' | 'delete' | 'update';
  patch?: Patch;
  before?: Patch | null;
  after?: Patch | null;
  previewUnavailable?: boolean;
};
export type AgentChangeReport = ChangeTurn & {
  aggregate?: Patch;
  edits: AgentEdit[];
  workspaceEdits?: AgentEdit[];
  limited?: boolean;
};
export type WorkspaceMode = 'files' | 'git' | 'agent';

export function pathJoin(parent: string, name: string, separator = '/') {
  return parent
    ? (parent.endsWith(separator) ? parent : parent + separator) + name
    : name;
}
