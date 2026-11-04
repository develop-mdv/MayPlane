import WorkspaceShell from '@/components/workspace-shell';
import { PanelAuth } from '@/components/panel-auth';
export default function Home() {
  return <PanelAuth><WorkspaceShell /></PanelAuth>;
}
