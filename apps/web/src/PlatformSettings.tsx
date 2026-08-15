import { Check, Clipboard, Download, KeyRound, Shield, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type {
  ApiTokenScope,
  ApiTokenSummary,
  CalendarConnectionSummary,
  CalendarEventSummary,
  CreatedApiToken,
  EnterpriseSettingsSummary,
  ExportJobSummary,
} from '@rdocs/shared';

import {
  createApiToken,
  createCalendarConnection,
  createExportJob,
  createScimToken,
  deleteCalendarConnection,
  getAiSettings,
  getEnterpriseSettings,
  listApiTokens,
  listCalendarConnections,
  listCalendarEvents,
  listExportJobs,
  revokeApiToken,
  updateEnterpriseSettings,
} from './api';

const SCOPES: Array<{ id: ApiTokenScope; label: string }> = [
  { id: 'pages:read', label: '读取页面' },
  { id: 'pages:write', label: '写入页面' },
  { id: 'databases:read', label: '读取数据库' },
  { id: 'databases:write', label: '写入数据库' },
  { id: 'search:read', label: '搜索' },
  { id: 'admin', label: '管理' },
];

function failure(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function PlatformSettings({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const [tab, setTab] = useState<'tokens' | 'exports' | 'ai' | 'calendar' | 'enterprise'>('tokens');
  const [calendars, setCalendars] = useState<CalendarConnectionSummary[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEventSummary[]>([]);
  const [calendarName, setCalendarName] = useState('工作日历');
  const [icsUrl, setIcsUrl] = useState('');
  const [activeCalendarId, setActiveCalendarId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [tokenName, setTokenName] = useState('本地集成');
  const [scopes, setScopes] = useState<ApiTokenScope[]>(['pages:read', 'search:read']);
  const [jobs, setJobs] = useState<ExportJobSummary[]>([]);
  const [enterprise, setEnterprise] = useState<EnterpriseSettingsSummary | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scimToken, setScimToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    setError(null);
    try {
      const [tokenResult, exportResult, enterpriseResult, aiResult, calendarResult] =
        await Promise.all([
          listApiTokens(organizationId),
          listExportJobs(organizationId),
          getEnterpriseSettings(organizationId),
          getAiSettings(organizationId),
          listCalendarConnections(organizationId),
        ]);
      setTokens(tokenResult.tokens);
      setJobs(exportResult.jobs);
      setEnterprise(enterpriseResult.settings);
      setAiConfigured(aiResult.settings.configured);
      setCalendars(calendarResult.connections);
    } catch (reason) {
      setError(failure(reason, '无法加载平台设置'));
    }
  }, [canManage, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canManage) return null;

  const createToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createApiToken(organizationId, { name: tokenName, scopes });
      setCreated(result.token);
      await load();
    } catch (reason) {
      setError(failure(reason, '无法创建令牌'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tenant-panel organization-settings">
      <div className="tenant-panel-heading">
        <div>
          <span>开发者、导出、AI 与企业治理</span>
          <small>令牌权限不会超过当前用户；缺少外部凭据时功能会明确降级</small>
        </div>
      </div>
      <div className="context-tabs" style={{ height: 44 }}>
        {(
          [
            ['tokens', 'API 令牌'],
            ['exports', '导出'],
            ['ai', 'AI'],
            ['calendar', '日历'],
            ['enterprise', '企业'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'active' : ''}
            type="button"
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'tokens' ? (
        <>
          <form className="member-invite-form" onSubmit={(event) => void createToken(event)}>
            <label>
              <span>名称</span>
              <input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                maxLength={80}
              />
            </label>
            <div className="dialog-actions" style={{ flexWrap: 'wrap' }}>
              {SCOPES.map((scope) => (
                <label key={scope.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope.id)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope.id]
                          : current.filter((item) => item !== scope.id),
                      )
                    }
                  />
                  {scope.label}
                </label>
              ))}
            </div>
            <button className="primary-button" type="submit" disabled={busy}>
              <KeyRound size={16} /> 创建令牌
            </button>
          </form>
          {created ? (
            <div className="invite-link-result">
              <div>
                <Check size={16} />
                <span>只显示一次，请立即保存</span>
              </div>
              <code>{created.token}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(created.token);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Clipboard size={15} /> : <Clipboard size={15} />}
                复制
              </button>
            </div>
          ) : null}
          <div className="member-table-wrap">
            <table className="member-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>权限</th>
                  <th>前缀</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens
                  .filter((token) => !token.revokedAt)
                  .map((token) => (
                    <tr key={token.id}>
                      <td>{token.name}</td>
                      <td>{token.scopes.join(', ')}</td>
                      <td>
                        <code>{token.tokenPrefix}…</code>
                      </td>
                      <td>
                        <button
                          className="danger"
                          type="button"
                          onClick={() =>
                            void revokeApiToken(organizationId, token.id).then(() => load())
                          }
                        >
                          撤销
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'exports' ? (
        <div className="dialog-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void createExportJob(organizationId, { kind: 'workspace', format: 'markdown' })
                .then(() => load())
                .catch((reason) => setError(failure(reason, '导出失败')))
                .finally(() => setBusy(false));
            }}
          >
            <Download size={16} /> 导出工作区 Markdown
          </button>
          {jobs.map((job) => (
            <div key={job.id} className="invite-link-result">
              <strong>
                {job.kind} / {job.format}
              </strong>
              <small>
                {job.status} · {job.pageCount} 页 · {new Date(job.createdAt).toLocaleString()}
              </small>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'ai' ? (
        <p>
          <Sparkles size={16} /> 页面 AI 走 SpaceXAI（xAI）。当前
          {aiConfigured
            ? '已配置模型端点与密钥。'
            : '未配置 AI_API_KEY / AI_API_BASE，请求会安全降级并留下审计。把端点和密钥交给我后即可写入 RandallFlare。'}
        </p>
      ) : null}

      {tab === 'enterprise' && enterprise ? (
        <form
          className="member-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void updateEnterpriseSettings(organizationId, {
              samlEnabled: enterprise.samlEnabled,
              samlEntityId: enterprise.samlEntityId ?? undefined,
              samlSsoUrl: enterprise.samlSsoUrl ?? undefined,
              scimEnabled: enterprise.scimEnabled,
              legalHold: enterprise.legalHold,
              sessionMaxAgeHours: enterprise.sessionMaxAgeHours,
            })
              .then((result) => setEnterprise(result.settings))
              .catch((reason) => setError(failure(reason, '无法保存企业设置')))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            <span>SAML Entity ID</span>
            <input
              value={enterprise.samlEntityId ?? ''}
              onChange={(event) =>
                setEnterprise({ ...enterprise, samlEntityId: event.target.value || null })
              }
            />
          </label>
          <label>
            <span>SAML SSO URL</span>
            <input
              value={enterprise.samlSsoUrl ?? ''}
              onChange={(event) =>
                setEnterprise({ ...enterprise, samlSsoUrl: event.target.value || null })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={enterprise.samlEnabled}
              onChange={(event) =>
                setEnterprise({ ...enterprise, samlEnabled: event.target.checked })
              }
            />
            启用 SAML（保存元数据后作为企业入口，不替代设备密钥）
          </label>
          <label>
            <input
              type="checkbox"
              checked={enterprise.scimEnabled}
              onChange={(event) =>
                setEnterprise({ ...enterprise, scimEnabled: event.target.checked })
              }
            />
            启用 SCIM 生命周期
          </label>
          <label>
            <input
              type="checkbox"
              checked={enterprise.legalHold}
              onChange={(event) =>
                setEnterprise({ ...enterprise, legalHold: event.target.checked })
              }
            />
            组织级法务保全（阻止删除）
          </label>
          <div className="dialog-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              <Shield size={16} /> 保存企业设置
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void createScimToken(organizationId)
                  .then((result) => setScimToken(result.token))
                  .catch((reason) => setError(failure(reason, '无法生成 SCIM 令牌')))
                  .finally(() => setBusy(false));
              }}
            >
              生成 SCIM 令牌
            </button>
          </div>
          {scimToken ? <code>{scimToken}</code> : null}
        </form>
      ) : null}

      {tab === 'calendar' ? (
        <div>
          <form
            className="member-invite-form"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void createCalendarConnection(organizationId, { icsUrl, name: calendarName })
                .then(() => {
                  setIcsUrl('');
                  return load();
                })
                .catch((reason) => setError(failure(reason, '无法添加日历')))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              <span>名称</span>
              <input
                value={calendarName}
                maxLength={80}
                onChange={(event) => setCalendarName(event.target.value)}
              />
            </label>
            <label>
              <span>ICS 地址</span>
              <input
                value={icsUrl}
                required
                placeholder="https://…"
                onChange={(event) => setIcsUrl(event.target.value)}
              />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              添加 ICS 日历
            </button>
          </form>
          <div className="database-calendar-list">
            {calendars.map((calendar) => (
              <article key={calendar.id}>
                <strong>{calendar.name}</strong>
                <small>
                  {calendar.status === 'error' ? calendar.errorMessage || '读取失败' : '已配置'}
                </small>
                <div className="dialog-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setActiveCalendarId(calendar.id);
                      void listCalendarEvents(organizationId, calendar.id)
                        .then((result) => setCalendarEvents(result.events))
                        .catch((reason) => setError(failure(reason, '无法读取日程')))
                        .finally(() => setBusy(false));
                    }}
                  >
                    查看日程
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void deleteCalendarConnection(organizationId, calendar.id)
                        .then(() => {
                          if (activeCalendarId === calendar.id) {
                            setActiveCalendarId(null);
                            setCalendarEvents([]);
                          }
                          return load();
                        })
                        .catch((reason) => setError(failure(reason, '无法删除日历')))
                        .finally(() => setBusy(false));
                    }}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
          {activeCalendarId ? (
            <div className="database-calendar-list">
              {calendarEvents.length ? (
                calendarEvents.map((event) => (
                  <article key={event.uid}>
                    <strong>{event.title}</strong>
                    <time>
                      {event.startsAt ? new Date(event.startsAt).toLocaleString() : '未安排'}
                      {event.location ? ` · ${event.location}` : ''}
                    </time>
                  </article>
                ))
              ) : (
                <p>这个日历暂时没有可显示的日程。</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
