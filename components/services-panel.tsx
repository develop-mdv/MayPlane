'use client';
import { ArrowUpRight, Boxes, Monitor } from 'lucide-react';
import type { HubSnapshot } from '@/lib/hub';
import type { Server } from '@/lib/domain';

export function ServicesPanel({
  services,
  machines,
}: {
  services: HubSnapshot['services'];
  machines: Server[];
}) {
  const labels: Record<string, string> = {
    running: 'Работает',
    stopped: 'Остановлен',
    failed: 'Ошибка',
    deploying: 'Выполняется',
    needs_setup: 'Нужна настройка',
  };
  return (
    <div className="hub-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ПРИЛОЖЕНИЯ НА СЕРВЕРАХ</span>
          <h1>
            Сервисы<span className="heading-count">{services.length}</span>
          </h1>
          <p>Приложения, боты и службы на ваших машинах.</p>
        </div>
      </div>
      <div className="services-note">
        <Boxes size={20} />
        <p>
          Сервисы объединяют развёрнутые приложения. Рабочие папки и чаты с
          агентами находятся в разделе «Проекты».
        </p>
      </div>
      {services.length ? (
        <div className="projects-grid">
          {services.map((s) => (
            <article key={s.id} className="project-card">
              <div className="project-card-heading">
                <span className="project-icon">
                  <Boxes size={22} />
                </span>
                <span
                  className={`state-badge ${s.status === 'running' ? 'online' : ''}`}
                >
                  {labels[s.status] || s.status}
                </span>
              </div>
              <h2>{s.name}</h2>
              <p className="service-machine">
                <Monitor size={13} />
                {machines.find((m) => m.id === s.machineId)?.name || 'Машина'}
              </p>
              {s.repo && (
                <a
                  className="project-repo"
                  href={s.repo}
                  target="_blank"
                  rel="noreferrer"
                >
                  {s.repo
                    .replace('https://github.com/', '')
                    .replace(/\.git$/, '')}
                  <ArrowUpRight size={13} />
                </a>
              )}
              {s.domain && <p className="service-domain">{s.domain}</p>}
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Boxes size={30} />
          <h2>Пока нет сервисов</h2>
          <p>Рабочие папки и чаты создаются в разделе «Проекты».</p>
        </div>
      )}
    </div>
  );
}
