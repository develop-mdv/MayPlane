'use client';
import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { WorkspaceApi } from '@/lib/workspace-files';
import { ErrorText } from './hub-ui';

export function useWorkspaceRead<T>(
  api: WorkspaceApi,
  endpoint: string | null,
  body?: object,
  revision = 0,
) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const key = `${endpoint}:${data}`;
  const [state, setState] = useState<{
    key: string;
    revision: number;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!endpoint) return;
    let current = true;
    void api<T>(
      endpoint,
      data === undefined ? 'GET' : 'POST',
      data === undefined ? undefined : JSON.parse(data),
    ).then(
      (response) => {
        if (current) setState({ key, revision, data: response });
      },
      (error: Error) => {
        if (current) setState({ key, revision, error: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [api, endpoint, data, key, revision]);
  const found = endpoint && state?.key === key ? state : undefined;
  return {
    data: found?.data,
    error: found?.revision === revision ? found.error : undefined,
    loading: !!endpoint && found?.revision !== revision,
  };
}

export function ReadStatus({
  loading,
  error,
}: {
  loading?: boolean;
  error?: string;
}) {
  return error ? (
    <ErrorText error={error} />
  ) : loading ? (
    <output className="files-note files-loading">
      <LoaderCircle size={15} className="spin" /> Загрузка…
    </output>
  ) : null;
}
