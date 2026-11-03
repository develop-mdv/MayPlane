'use client';
import { useState } from 'react';
import { GitBranch, LockKeyhole } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { Workspace } from '@/lib/use-workspace';
export type GitRepo = {
  fullName: string;
  repo: string;
  branch: string;
  private: boolean;
};
export function GitConnections({ ws }: { ws: Workspace }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  return (
    <section className="git-settings">
      <h2>
        <GitBranch size={21} /> GitHub
      </h2>
      <p>
        Подключите аккаунт, чтобы выбирать и разворачивать приватные
        репозитории.
      </p>
      <div className="git-accounts">
        {ws.data.gitConnections?.map((c) => (
          <div key={c.id}>
            <GitBranch size={18} />
            <strong>{c.login}</strong>
            <span>Подключён</span>
          </div>
        ))}
      </div>
      <form
        className="flow-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setMessage('');
          try {
            await ws.action('/git/connections', { token });
            setToken('');
            setMessage(
              'GitHub подключён. Репозитории доступны при создании проекта.',
            );
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label className="form-field" htmlFor="github-access-token">
          <span>Personal Access Token</span>
          <Input
            id="github-access-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
            required
            minLength={20}
          />
          <small>
            Fine-grained token: выберите нужные репозитории и Contents →
            Read-only. Повторное подключение того же аккаунта обновит токен.
          </small>
        </label>
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
          className="text-link"
        >
          Создать токен в GitHub ↗
        </a>
        <p className="secure-note">
          <LockKeyhole size={14} />
          Токен хранится зашифрованным у исполнителя.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {message && <output className="form-success">{message}</output>}
        <Button
          className="primary-button"
          type="submit"
          disabled={!ws.connection || ws.busy}
        >
          {ws.busy ? 'Проверяем…' : 'Подключить GitHub'}
        </Button>
      </form>
    </section>
  );
}
