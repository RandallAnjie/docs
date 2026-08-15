import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type {
  DeviceSummary,
  DirectoryPerson,
  NotificationPreferences,
  OAuthAppSummary,
  SessionSummary,
  WorkspaceSkillSummary,
  WorkspaceTemplateSummary,
} from '@rdocs/shared';

import {
  createOAuthApp,
  createWorkspaceSkill,
  deleteWorkspaceSkill,
  getNotificationPreferences,
  instantiateWorkspaceTemplate,
  listDevices,
  listDirectory,
  listOAuthApps,
  listSessions,
  listWorkspaceSkills,
  listWorkspaceTemplates,
  revokeDevice,
  revokeSession,
  updateNotificationPreferences,
} from './api';
import { copyPage } from './api';
import { navigateToPage } from './navigation';

function fail(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function WorkspaceExtras({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [query, setQuery] = useState('');
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [templates, setTemplates] = useState<WorkspaceTemplateSummary[]>([]);
  const [skills, setSkills] = useState<WorkspaceSkillSummary[]>([]);
  const [apps, setApps] = useState<OAuthAppSummary[]>([]);
  const [skillName, setSkillName] = useState('');
  const [skillPrompt, setSkillPrompt] = useState('');
  const [appName, setAppName] = useState('');
  const [redirectUri, setRedirectUri] = useState('https://');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sessionResult, deviceResult, directory, preference, templateResult, skillResult] =
        await Promise.all([
          listSessions(),
          listDevices(),
          listDirectory(organizationId, query),
          getNotificationPreferences(organizationId),
          listWorkspaceTemplates(organizationId),
          listWorkspaceSkills(organizationId),
        ]);
      setSessions(sessionResult.sessions);
      setDevices(deviceResult.devices);
      setPeople(directory.people);
      setPrefs(preference.preferences);
      setTemplates(templateResult.templates);
      setSkills(skillResult.skills);
      if (canManage) {
        const oauth = await listOAuthApps(organizationId);
        setApps(oauth.apps);
      }
    } catch (reason) {
      setError(fail(reason, '无法加载工作区扩展设置'));
    }
  }, [canManage, organizationId, query]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="tenant-panel organization-settings">
      <div className="tenant-panel-heading">
        <div>
          <span>安全、通讯录、模板与技能</span>
          <small>会话、设备密钥、邮件偏好、组织模板和 Agent 技能</small>
        </div>
      </div>

      <h3>登录会话</h3>
      {sessions.map((session) => (
        <div key={session.id} className="member-row">
          <div>
            <strong>{session.current ? '当前会话' : '其他会话'}</strong>
            <small>最近活动 {new Date(session.lastSeenAt).toLocaleString()}</small>
          </div>
          {!session.current ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void revokeSession(session.id)
                  .then(() => load())
                  .catch((reason) => setError(fail(reason, '无法撤销会话')))
                  .finally(() => setBusy(false));
              }}
            >
              退出
            </button>
          ) : null}
        </div>
      ))}

      <h3>设备密钥</h3>
      {devices.map((device) => (
        <div key={device.credentialId} className="member-row">
          <div>
            <strong>{device.label}</strong>
            <small>
              {device.deviceType === 'multiDevice' ? '可同步' : '本机'} · 登记于{' '}
              {new Date(device.createdAt).toLocaleDateString()}
            </small>
          </div>
          <button
            type="button"
            disabled={busy || devices.length <= 1}
            onClick={() => {
              setBusy(true);
              void revokeDevice(device.credentialId)
                .then(() => load())
                .catch((reason) => setError(fail(reason, '无法移除设备')))
                .finally(() => setBusy(false));
            }}
          >
            移除
          </button>
        </div>
      ))}

      <h3>邮件通知</h3>
      {prefs ? (
        <div className="database-automation-grid">
          <label className="database-dialog-checkbox">
            <input
              type="checkbox"
              checked={prefs.emailMentions}
              onChange={(event) => {
                const emailMentions = event.target.checked;
                setPrefs({ ...prefs, emailMentions });
                void updateNotificationPreferences(organizationId, { emailMentions });
              }}
            />
            提及邮件
          </label>
          <label className="database-dialog-checkbox">
            <input
              type="checkbox"
              checked={prefs.emailReminders}
              onChange={(event) => {
                const emailReminders = event.target.checked;
                setPrefs({ ...prefs, emailReminders });
                void updateNotificationPreferences(organizationId, { emailReminders });
              }}
            />
            提醒邮件
          </label>
          <label className="database-dialog-checkbox">
            <input
              type="checkbox"
              checked={prefs.emailDigest}
              onChange={(event) => {
                const emailDigest = event.target.checked;
                setPrefs({ ...prefs, emailDigest });
                void updateNotificationPreferences(organizationId, { emailDigest });
              }}
            />
            每日摘要
          </label>
        </div>
      ) : null}

      <h3>通讯录</h3>
      <input
        value={query}
        placeholder="搜索姓名或邮箱"
        onChange={(event) => setQuery(event.target.value)}
      />
      {people.map((person) => (
        <div key={person.userId} className="member-row">
          <div>
            <strong>{person.displayName}</strong>
            <small>
              {person.email} · {person.role}
            </small>
          </div>
        </div>
      ))}

      <h3>组织模板</h3>
      {templates.map((template) => (
        <div key={template.id} className="member-row">
          <div>
            <strong>{template.name}</strong>
            <small>{template.description || '从已有页面发布'}</small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void instantiateWorkspaceTemplate(template.id)
                .then(async (result) => {
                  const copied = await copyPage(result.sourcePageId, { title: result.title });
                  navigateToPage(copied.page.id);
                })
                .catch((reason) => setError(fail(reason, '无法使用模板')))
                .finally(() => setBusy(false));
            }}
          >
            使用
          </button>
        </div>
      ))}

      <h3>Agent 技能</h3>
      <form
        className="member-invite-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setBusy(true);
          void createWorkspaceSkill(organizationId, { name: skillName, prompt: skillPrompt })
            .then(() => {
              setSkillName('');
              setSkillPrompt('');
              return load();
            })
            .catch((reason) => setError(fail(reason, '无法创建技能')))
            .finally(() => setBusy(false));
        }}
      >
        <input
          value={skillName}
          required
          placeholder="技能名称"
          onChange={(event) => setSkillName(event.target.value)}
        />
        <textarea
          value={skillPrompt}
          required
          placeholder="系统提示词"
          onChange={(event) => setSkillPrompt(event.target.value)}
        />
        <button className="primary-button" type="submit" disabled={busy}>
          保存技能
        </button>
      </form>
      {skills.map((skill) => (
        <div key={skill.id} className="member-row">
          <div>
            <strong>{skill.name}</strong>
            <small>{skill.prompt.slice(0, 80)}</small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void deleteWorkspaceSkill(organizationId, skill.id)
                .then(() => load())
                .catch((reason) => setError(fail(reason, '无法删除技能')))
                .finally(() => setBusy(false));
            }}
          >
            删除
          </button>
        </div>
      ))}

      {canManage ? (
        <>
          <h3>OAuth 应用</h3>
          <form
            className="member-invite-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setBusy(true);
              void createOAuthApp(organizationId, { name: appName, redirectUri })
                .then((result) => {
                  setCreatedSecret(`${result.clientId} / ${result.clientSecret}`);
                  setAppName('');
                  return load();
                })
                .catch((reason) => setError(fail(reason, '无法创建应用')))
                .finally(() => setBusy(false));
            }}
          >
            <input
              value={appName}
              required
              placeholder="应用名称"
              onChange={(event) => setAppName(event.target.value)}
            />
            <input
              value={redirectUri}
              required
              placeholder="https:// 回调"
              onChange={(event) => setRedirectUri(event.target.value)}
            />
            <button className="primary-button" type="submit" disabled={busy}>
              创建应用
            </button>
          </form>
          {createdSecret ? <code>{createdSecret}</code> : null}
          {apps.map((app) => (
            <div key={app.id} className="member-row">
              <div>
                <strong>{app.name}</strong>
                <small>{app.clientId}</small>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
