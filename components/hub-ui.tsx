'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Copy, Check, X, LoaderCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={`hub-modal ${wide ? 'hub-modal-wide' : ''}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description || 'Рабочее пространство MayPlane'}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function CopyButton({
  value,
  label = 'Скопировать',
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        className="icon-button"
        aria-label={copied ? 'Скопировано' : label}
        title={copied ? 'Скопировано' : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError('');
          } catch {
            setError('Не удалось скопировать. Выделите значение вручную.');
          }
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {error && (
        <span role="alert" className="inline-error">
          {error}
        </span>
      )}
    </>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="hub-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="hub-error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Submit({
  busy,
  disabled = false,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="submit" className="hub-button primary" disabled={busy || disabled}>
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export function Toast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return message ? (
    <div className="hub-toast" role="status">
      <Check size={17} />
      <span>{message}</span>
      <button
        className="icon-button"
        onClick={onClose}
        aria-label="Закрыть уведомление"
      >
        <X size={15} />
      </button>
    </div>
  ) : null;
}
