'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { MessageSquare, Send, Square, Terminal } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import type { Workspace } from '@/lib/use-workspace';
import type { ChatMessage, Server, Project } from '@/lib/domain';

const labels = {
  user: 'Вы',
  assistant: 'Помощник',
  command: 'Команда',
  result: 'Результат',
  system: 'Исполнитель',
};
export function OperationsChat({
  ws,
  project,
  server,
}: {
  ws: Workspace;
  project?: Project;
  server: Server;
}) {
  const { api } = ws;
  const path = project
    ? `/projects/${project.id}/chat`
    : `/servers/${server.id}/chat`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const selectId = useId();
  const models = (ws.data.llm?.models || []).filter((model) => model.enabled);
  const preferredModel =
    models.find((model) => model.id === ws.data.llm?.defaultModelId) ||
    models[0];
  const [modelId, setModelId] = useState(preferredModel?.id || '');
  const selectedModelId = models.some((model) => model.id === modelId)
    ? modelId
    : preferredModel?.id || '';
  const tail = useRef<HTMLDivElement>(null);
  const currentJobs = ws.data.jobs.filter((j) =>
    project
      ? j.projectId === project.id
      : !j.projectId && j.serverId === server.id,
  );
  const job = currentJobs.find((j) => ['chat', 'auto-deploy'].includes(j.type));
  const active = ws.data.jobs.find(
    (j) =>
      ['pending', 'deploying'].includes(j.status) &&
      (j.serverId === server.id ||
        j.target === server.id ||
        ws.data.projects.some(
          (p) => p.id === j.projectId && p.serverId === server.id,
        )),
  );
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ messages: ChatMessage[] }>(path);
        if (!stopped) {
          setMessages(result.messages);
          setLoaded(true);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [path, api]);
  useEffect(() => {
    tail.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);
  return (
    <section className="operations-chat">
      <p className="detail-copy">
        {project
          ? 'Опишите, что нужно развернуть или исправить. Помощник изучит проект, выполнит команды и проверит результат.'
          : 'Опишите задачу администрирования. Помощник проверит сервер и выполнит необходимые команды по SSH.'}{' '}
        Команды выполняются сразу. Ключи приложения вводите в «Переменных»
        проекта.
      </p>
      {!models.length && (
        <div className="inline-notice">
          Добавьте и включите хотя бы одну модель в настройках панели.
        </div>
      )}
      <div
        className="chat-history"
        role="log"
        aria-label="История чата"
        aria-live="polite"
      >
        {!messages.length && (
          <div className="chat-empty">
            <MessageSquare size={26} />
            <p>
              {loaded
                ? 'Здесь появятся сообщения, команды и их вывод.'
                : 'Загружаем историю…'}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <article key={m.id} className={`chat-message chat-${m.role}`}>
            <header>
              <strong>{labels[m.role]}</strong>
              <time dateTime={m.createdAt}>
                {new Date(m.createdAt).toLocaleTimeString('ru', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              {m.success === false && (
                <span className="chat-failure">Ошибка</span>
              )}
            </header>
            {['command', 'result'].includes(m.role) ? (
              <details open={m.success === false || m.role === 'command'}>
                <summary>
                  <Terminal size={13} />
                  {m.role === 'command' ? 'Команда SSH' : 'Вывод выполнения'}
                </summary>
                <pre>{m.content}</pre>
              </details>
            ) : (
              <p>{m.content}</p>
            )}
          </article>
        ))}
        <div ref={tail} />
      </div>
      {job?.status === 'failed' && (
        <p className="form-error" role="alert">
          {job.logs.at(-1) || 'Задача завершилась ошибкой.'}
        </p>
      )}
      {job?.usage && (
        <small className="muted">
          Последняя задача: {job.usage.calls} обращений к модели ·{' '}
          {job.usage.input} входных / {job.usage.output} выходных токенов
        </small>
      )}
      {active && (
        <div className="chat-progress">
          <span>
            {active.cancelRequested
              ? 'Прерываем текущую команду…'
              : 'На сервере выполняется задача…'}
          </span>
          {['chat', 'auto-deploy'].includes(active.type) && (
            <Button
              variant="outline"
              size="sm"
              disabled={!!active.cancelRequested || sending}
              onClick={async () => {
                try {
                  await ws.action(`/jobs/${active.id}/cancel`);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Square size={13} />
              Прервать выполнение
            </Button>
          )}
        </div>
      )}
      <form
        className="chat-composer"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setSending(true);
          try {
            await ws.action(path, {
              message: text,
              modelId: selectedModelId,
            });
            setText('');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSending(false);
          }
        }}
      >
        <Textarea
          aria-label="Сообщение помощнику"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          rows={3}
          placeholder={
            project
              ? 'Разверни проект, настрой запуск и сохрани команды управления…'
              : 'Проверь свободное место и объясни, что его занимает…'
          }
          disabled={sending}
        />
        <div className="chat-composer-actions">
          <label htmlFor={selectId}>
            <span>Модель</span>
            <NativeSelect
              id={selectId}
              value={selectedModelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={sending || !!active || !models.length}
              aria-label="Модель для сообщения"
            >
              {!models.length && (
                <NativeSelectOption value="">
                  Нет доступных моделей
                </NativeSelectOption>
              )}
              {models.map((model) => (
                <NativeSelectOption key={model.id} value={model.id}>
                  {model.name} · {model.model}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <Button
            className="primary-button"
            type="submit"
            disabled={
              !text.trim() || sending || !!active || !selectedModelId
            }
          >
            <Send size={15} />
            {sending ? 'Отправляем…' : 'Отправить'}
          </Button>
        </div>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function ServerChat({
  ws,
  server,
  onClose,
}: {
  ws: Workspace;
  server: Server | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!server}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="server-chat-dialog">
        <DialogHeader>
          <DialogTitle>Чат · {server?.name}</DialogTitle>
          <DialogDescription>
            Администрирование сервера через помощника
          </DialogDescription>
        </DialogHeader>
        {server && <OperationsChat key={server.id} ws={ws} server={server} />}
      </DialogContent>
    </Dialog>
  );
}
