import { FileText, KeyRound, LockKeyhole, Table2, Users } from 'lucide-react';

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

export function LandingPage() {
  return (
    <main className="welcome-shell landing-shell">
      <nav className="welcome-nav">
        <Brand />
        <div className="landing-nav-actions">
          <a className="quiet-link" href="/login">
            登录
          </a>
          <a className="primary-button" href="/register">
            <KeyRound size={16} />
            注册
          </a>
        </div>
      </nav>
      <span className="welcome-orbit orbit-one" aria-hidden="true" />
      <span className="welcome-orbit orbit-two" aria-hidden="true" />
      <section className="welcome-content">
        <span className="eyebrow">Passkey · 实时协作 · 自托管</span>
        <h1>团队知识，写在同一页上。</h1>
        <p>
          Rdocs
          是设备密钥优先的协作文档空间。登录和注册都不需要密码，私钥留在你的设备上；页面、数据库和权限在同一个工作区里完成。
        </p>
        <div className="welcome-actions">
          <a className="primary-button" href="/register">
            <KeyRound size={17} />
            用设备密钥注册
          </a>
          <a className="quiet-link" href="/login">
            已有账号？登录
          </a>
        </div>
        <div className="landing-feature-grid">
          <article>
            <KeyRound size={18} />
            <strong>设备密钥登录</strong>
            <p>生物识别、系统 PIN 或安全密钥。没有密码库，也没有 GitHub OAuth。</p>
          </article>
          <article>
            <Users size={18} />
            <strong>实时共创</strong>
            <p>多人光标、自动保存、评论和版本恢复，刷新或掉线后仍能收敛。</p>
          </article>
          <article>
            <Table2 size={18} />
            <strong>文档与数据库</strong>
            <p>页面树、数据库视图、表单和自动化共用同一套权限边界。</p>
          </article>
          <article>
            <LockKeyhole size={18} />
            <strong>权限可收回</strong>
            <p>空间和页面四级授权。撤销后新请求和已打开的协作连接都会失效。</p>
          </article>
        </div>
        <div className="preview-note">
          <FileText size={16} />
          <span>
            <strong>注册即创建工作区。</strong>
            设备只把公钥交给 Rdocs，生物识别数据不会离开本机。
          </span>
        </div>
      </section>
    </main>
  );
}
