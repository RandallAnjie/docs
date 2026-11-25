import { FileText, LockKeyhole, LogIn, ShieldCheck, Table2, Users } from 'lucide-react';

function Brand() {
  return (
    <a className="brand" href="/">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <strong>Rdocs</strong>
    </a>
  );
}

export function LandingPage({ loginHref }: { loginHref: string }) {
  return (
    <main className="welcome-shell landing-shell">
      <nav className="welcome-nav">
        <Brand />
        <div className="landing-nav-actions">
          <a className="primary-button compact-button" href={loginHref}>
            <LogIn size={16} />
            登录
          </a>
        </div>
      </nav>
      <span className="welcome-orbit orbit-one" aria-hidden="true" />
      <span className="welcome-orbit orbit-two" aria-hidden="true" />
      <section className="welcome-content">
        <span className="eyebrow">RandallFlare 登录 · 实时协作 · 自托管</span>
        <h1>团队知识，写在同一页上。</h1>
        <p>
          Rdocs 是运行在 RandallFlare 上的协作文档空间。用你的 RandallFlare
          账户登录即可进入，页面、数据库和权限在同一个工作区里完成。
        </p>
        <div className="welcome-actions">
          <a className="primary-button" href={loginHref}>
            <LogIn size={17} />
            使用 RandallFlare 登录
          </a>
        </div>
        <div className="landing-feature-grid">
          <article>
            <ShieldCheck size={18} aria-hidden="true" />
            <strong>统一账户</strong>
            <p>由 RandallFlare 网关完成登录和成员校验，Rdocs 不保存任何密码或密钥。</p>
          </article>
          <article>
            <Users size={18} aria-hidden="true" />
            <strong>实时共创</strong>
            <p>多人光标、自动保存、评论和版本恢复，刷新或掉线后仍能收敛。</p>
          </article>
          <article>
            <Table2 size={18} aria-hidden="true" />
            <strong>文档与数据库</strong>
            <p>页面树、数据库视图、表单和自动化共用同一套权限边界。</p>
          </article>
          <article>
            <LockKeyhole size={18} aria-hidden="true" />
            <strong>权限可收回</strong>
            <p>空间和页面四级授权。撤销后新请求和已打开的协作连接都会失效。</p>
          </article>
        </div>
        <div className="preview-note">
          <FileText size={16} aria-hidden="true" />
          <span>
            <strong>首次登录即创建工作区。</strong>
            只有 Rdocs 成员名单里的 RandallFlare 账户可以进入；分享链接和发布站点仍可公开访问。
          </span>
        </div>
      </section>
    </main>
  );
}
