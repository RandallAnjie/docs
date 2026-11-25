import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type {
  DirectoryPerson,
  NotificationPreferences,
  OAuthAppSummary,
  WorkspaceSkillSummary,
  WorkspaceTemplateSummary,
} from '@rdocs/shared';

import {
  createOAuthApp,
  createWorkspaceSkill,
  deleteWorkspaceSkill,
  getNotificationPreferences,
  instantiateWorkspaceTemplate,
  listDirectory,
  listOAuthApps,
  listWorkspaceSkills,
  listWorkspaceTemplates,
  updateNotificationPreferences,
} from './api';
import { copyPage } from './api';
import { navigateToPage } from './navigation';

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  guest: '外部只读',
};

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
      const [directory, preference, templateResult, skillResult] = await Promise.all([
        listDirectory(organizationId, query),
        getNotificationPreferences(organizationId),
        listWorkspaceTemplates(organizationId),
        listWorkspaceSkills(organizationId),
      ]);
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
          <span>通知与扩展</span>
          <small>邮件偏好、通讯录、组织模板和 Agent 技能</small>
        </div>
      </div>

      <h3>登录与账户</h3>
      <p className="tenant-panel-note">
        Rdocs 通过 RandallFlare 账户登录，不保存密码或设备密钥。登录设备、两步验证和会话请在
        RandallFlare 账户设置中管理。
      </p>

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
        className="settings-search"
        type="search"
        value={query}
        placeholder="搜索姓名或邮箱"
        aria-label="搜索通讯录"
        onChange={(event) => setQuery(event.target.value)}
      />
      {people.map((person) => (
        <div key={person.userId} className="member-row">
          <div>
            <strong>{person.displayName}</strong>
            <small>
              {person.email} · {ROLE_LABELS[person.role] ?? person.role}
            </small>
          </div>
        </div>
      ))}

      <h3>组织模板</h3>
      {!templates.length ? <p className="tenant-panel-note">还没有组织模板。</p> : null}
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
        className="settings-form"
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
          rows={4}
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
            className="settings-form"
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
