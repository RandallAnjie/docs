import { BookOpen, CalendarDays, FileText, FolderKanban, X } from 'lucide-react';
import { useState } from 'react';

import type { SpaceSummary } from '@rdocs/shared';

import { createProjectWorkspace, importMarkdown } from './api';

const TEMPLATES = [
  {
    id: 'meeting',
    name: '会议纪要',
    description: '议题、讨论、决策和待办',
    icon: CalendarDays,
    markdown:
      '# 会议纪要\n\n## 会议信息\n\n- 日期：\n- 参会人：\n- 主持人：\n\n## 议题\n\n## 讨论与决策\n\n## 待办\n\n- [ ] 待办项',
  },
  {
    id: 'project',
    name: '项目计划',
    description: '目标、里程碑、风险和状态记录',
    icon: FolderKanban,
    markdown:
      '# 项目计划\n\n## 目标\n\n## 范围\n\n## 里程碑\n\n1. 启动\n2. 实施\n3. 交付\n\n## 风险\n\n## 每周进展',
  },
  {
    id: 'knowledge',
    name: '知识文章',
    description: '适合团队手册和技术方案',
    icon: BookOpen,
    markdown:
      '# 知识文章\n\n> 用一句话说明这篇文档解决什么问题。\n\n## 背景\n\n## 方案\n\n## 例子\n\n## 相关资料',
  },
  {
    id: 'blank',
    name: '空白结构',
    description: '带基础章节的通用起点',
    icon: FileText,
    markdown: '# 未命名文档\n\n## 概述\n\n## 正文',
  },
] as const;

export function TemplateDialog({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (template: (typeof TEMPLATES)[number]) => {
    if (creatingId) return;
    setCreatingId(template.id);
    setError(null);
    try {
      const file = new File([template.markdown], `${template.name}.md`, { type: 'text/markdown' });
      const { page } = await importMarkdown(space.id, file);
      window.location.assign(`/p/${encodeURIComponent(page.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法从模板创建页面');
      setCreatingId(null);
    }
  };

  const createProjects = async () => {
    if (creatingId) return;
    setCreatingId('project-workspace');
    setError(null);
    try {
      const { workspace } = await createProjectWorkspace(space.id);
      window.location.assign(`/p/${encodeURIComponent(workspace.projectsPageId)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建项目工作区');
      setCreatingId(null);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="rdocs-dialog template-dialog" role="dialog" aria-modal="true">
        <button className="dialog-close" type="button" onClick={onClose} aria-label="关闭">
          <X size={17} />
        </button>
        <div className="dialog-icon">
          <BookOpen size={19} />
        </div>
        <h2>从模板创建</h2>
        <p>在“{space.name}”中创建一个带有实用结构的新页面。</p>
        <div className="template-grid">
          <button
            className="template-project-workspace"
            type="button"
            onClick={() => void createProjects()}
            disabled={Boolean(creatingId)}
          >
            <span>
              <FolderKanban size={18} />
            </span>
            <strong>项目工作区</strong>
            <small>
              {creatingId === 'project-workspace'
                ? '正在创建项目、任务和 Sprint…'
                : '关联的项目、任务、Sprint、看板、日历与时间线'}
            </small>
          </button>
          {TEMPLATES.map((template) => {
            const Icon = template.icon;
            return (
              <button
                type="button"
                key={template.id}
                onClick={() => void create(template)}
                disabled={Boolean(creatingId)}
              >
                <span>
                  <Icon size={18} />
                </span>
                <strong>{template.name}</strong>
                <small>{creatingId === template.id ? '正在创建…' : template.description}</small>
              </button>
            );
          })}
        </div>
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
