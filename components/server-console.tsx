'use client';
import { useEffect, useRef, useState } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import {
  Terminal,
  RefreshCw,
  Unplug,
  Eraser,
  Copy,
  ClipboardPaste,
} from 'lucide-react';
import {
  terminalClipboardKey,
  terminalInputChunks,
} from '@/lib/terminal-input.mjs';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import type { Workspace } from '@/lib/use-workspace';
import type { Server } from '@/lib/domain';
export function ServerConsole({
  server,
  ws,
  onClose,
  initialCommand,
}: {
  server: Server | null;
  ws: Workspace;
  onClose: () => void;
  initialCommand?: string;
}) {
  return (
    <Dialog
      open={!!server}
      onOpenChange={(open, details) => {
        if (
          !open &&
          details.reason === 'escape-key' &&
          details.event.target instanceof Element &&
          details.event.target.closest('.ssh-terminal')
        ) {
          details.cancel();
          return;
        }
        if (!open) onClose();
      }}
    >
      <DialogContent className="server-console-dialog">
        {server && (
          <ConsoleBody
            key={server.id}
            server={server}
            ws={ws}
            initialCommand={initialCommand}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
function ConsoleBody({
  server,
  ws,
  initialCommand,
}: {
  server: Server;
  ws: Workspace;
  initialCommand?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const terminal = useRef<XTerminal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState('connecting');
  const [error, setError] = useState('');
  const { connection, terminalTicket } = ws;
  async function copySelection() {
    const text = terminal.current?.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError(
        'Не удалось скопировать выделение. Разрешите доступ к буферу обмена в браузере.',
      );
    }
  }
  async function pasteClipboard() {
    const target = terminal.current;
    if (!target || socket.current?.readyState !== WebSocket.OPEN) return;
    try {
      const text = await navigator.clipboard.readText();
      if (
        terminal.current !== target ||
        socket.current?.readyState !== WebSocket.OPEN
      )
        return;
      target.paste(text);
      target.focus();
    } catch {
      setError(
        'Не удалось прочитать буфер обмена. Разрешите вставку в браузере или используйте его контекстное меню.',
      );
    }
  }
  useEffect(() => {
    let cancelled = false;
    let term: XTerminal | undefined;
    let observer: ResizeObserver | undefined;
    let client: WebSocket | undefined;
    let ready = false;
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    async function start() {
      try {
        if (!connection)
          throw new Error('Подключите серверную часть в настройках.');
        const [{ Terminal: Term }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        if (cancelled || !host.current) return;
        term = new Term({
          cursorBlink: true,
          fontFamily: 'Consolas, "Liberation Mono", monospace',
          fontSize: 14,
          scrollback: 10000,
          scrollOnUserInput: true,
          theme: {
            background: '#121b22',
            foreground: '#e2ece7',
            cursor: '#79d4b3',
            selectionBackground: '#34524a',
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        terminal.current = term;
        term.attachCustomKeyEventHandler((event) =>
          terminalClipboardKey(event, {
            hasSelection: () => !!term?.hasSelection(),
            copy: () => {
              void copySelection();
            },
            paste: () => {
              if (ready) void pasteClipboard();
            },
            interrupt: () => {
              if (ready)
                client?.send(JSON.stringify({ type: 'input', data: '\u0003' }));
            },
          }),
        );
        fit.fit();
        const ticket = await terminalTicket(server.id);
        if (cancelled) return;
        const url = new URL(
          (connection.url || window.location.origin) +
            `/api/servers/${server.id}/terminal`,
        );
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        client = new WebSocket(url, ['ezdeploy-terminal', ticket.ticket]);
        socket.current = client;
        client.binaryType = 'arraybuffer';
        connectTimeout = setTimeout(() => {
          if (cancelled || ready) return;
          setError(
            'Сервер не ответил. Проверьте подключение и повторите попытку.',
          );
          setState('error');
          client?.close();
        }, 25000);
        const resize = () => {
          if (cancelled) return;
          fit.fit();
          if (client?.readyState === WebSocket.OPEN)
            client.send(
              JSON.stringify({
                type: 'resize',
                cols: Math.max(2, Math.min(500, term!.cols)),
                rows: Math.max(2, Math.min(200, term!.rows)),
              }),
            );
        };
        observer = new ResizeObserver(resize);
        observer.observe(host.current);
        term.onData((data) => {
          if (ready && client?.readyState === WebSocket.OPEN) {
            for (const chunk of terminalInputChunks(data))
              client.send(
                JSON.stringify({
                  type: 'input',
                  data: chunk,
                }),
              );
          }
        });
        client.onopen = () => {
          if (!cancelled) {
            setState('connecting');
            setError('');
          }
        };
        client.onmessage = (event) => {
          if (cancelled) return;
          if (event.data instanceof ArrayBuffer) {
            term?.write(new Uint8Array(event.data));
            return;
          }
          const message = JSON.parse(event.data);
          if (message.type === 'connected') resize();
          if (message.type === 'ready') {
            ready = true;
            clearTimeout(connectTimeout);
            setState('ready');
            term?.focus();
            if (initialCommand)
              client?.send(
                JSON.stringify({ type: 'input', data: initialCommand + '\r' }),
              );
          }
          if (message.type === 'error') {
            ready = false;
            setError(message.message);
            setState('error');
          }
          if (message.type === 'exit') {
            ready = false;
            setState((previous) =>
              previous === 'error' ? previous : 'closed',
            );
          }
        };
        client.onerror = () => {
          if (!cancelled) {
            setError(
              'Соединение с консолью прервано. Проверьте доступность исполнителя.',
            );
            setState('error');
          }
        };
        client.onclose = (event) => {
          ready = false;
          clearTimeout(connectTimeout);
          if (!cancelled && event.code === 1006) {
            setError('Связь с консолью потеряна. Нажмите «Подключиться».');
            setState('error');
            return;
          }
          if (!cancelled && event.reason) setError(event.reason);
          if (!cancelled)
            setState((previous) =>
              previous === 'error' ? previous : 'closed',
            );
        };
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setState('error');
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      ready = false;
      clearTimeout(connectTimeout);
      observer?.disconnect();
      if (client) {
        client.onmessage = null;
        client.onerror = null;
        client.onclose = null;
        client.close();
      }
      term?.dispose();
      terminal.current = null;
      socket.current = null;
    };
  }, [server.id, connection, terminalTicket, attempt, initialCommand]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Terminal size={20} /> Консоль · {server.name}
        </DialogTitle>
        <DialogDescription>
          {server.username}@{server.host}:{server.port} · интерактивный
          SSH-сеанс
        </DialogDescription>
      </DialogHeader>
      <div className="console-toolbar">
        <output className={state === 'ready' ? 'console-online' : ''}>
          {
            (
              {
                connecting: 'Подключаемся…',
                ready: 'Соединение открыто',
                closed: 'Сеанс завершён',
                error: 'Ошибка соединения',
              } as Record<string, string>
            )[state]
          }
        </output>
        <div>
          <Button
            variant="outline"
            disabled={state !== 'ready'}
            aria-label="Скопировать выделение"
            title="Ctrl+C — копировать выделение"
            onClick={() => void copySelection()}
          >
            <Copy size={15} />
          </Button>
          <Button
            variant="outline"
            disabled={state !== 'ready'}
            aria-label="Вставить из буфера"
            title="Ctrl+V — вставить"
            onClick={() => void pasteClipboard()}
          >
            <ClipboardPaste size={15} />
          </Button>
          <Button
            variant="outline"
            disabled={state !== 'ready'}
            onClick={() =>
              socket.current?.send(
                JSON.stringify({ type: 'input', data: '\u0003' }),
              )
            }
          >
            Прервать · Ctrl+C
          </Button>
          <Button
            variant="outline"
            aria-label="Очистить экран"
            onClick={() => terminal.current?.clear()}
          >
            <Eraser size={15} />
          </Button>
          {state === 'ready' || state === 'connecting' ? (
            <Button
              variant="outline"
              disabled={state === 'connecting'}
              onClick={() => {
                socket.current?.close();
                setState('closed');
              }}
            >
              <Unplug size={15} />
              Отключить
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setState('connecting');
                setError('');
                setAttempt((a) => a + 1);
              }}
            >
              <RefreshCw size={15} />
              Подключиться
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="ssh-terminal">
        <div className="ssh-terminal-host" ref={host} />
      </div>
      <p className="console-note">
        Ctrl+C копирует выделение, без выделения — прерывает команду. Ctrl+V
        вставляет текст. Прокрутка вверх показывает историю.
        <br />
        Команды выполняются с правами {server.username}. Закрытие окна завершает
        сеанс. Панель не записывает ввод и вывод; история команд может
        сохраняться оболочкой сервера.
      </p>
    </>
  );
}
