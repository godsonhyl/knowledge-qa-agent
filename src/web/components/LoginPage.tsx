/* ============================================================
   web/components/LoginPage.tsx —— 登录/注册页（WeKnora 模式）
   左侧品牌展示区 + 右侧表单卡。双模式：
   - 本地账号：邮箱+密码登录 / 注册（localEnabled 才显示）
   - SSO：单按钮跳 /api/auth/oidc/login（enabled 才显示）
   ============================================================ */
import { Button, Input } from 'tdesign-react';
import { useState } from 'react';
import type { SsoConfig } from '@shared/types.js';

type Mode = 'login' | 'register';

export function LoginPage({ sso, required }: { sso: SsoConfig; required: boolean }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redirecting, setRedirecting] = useState(false);

  const showLocal = !!sso.localEnabled;
  const showSso = !!sso.enabled;
  const showRegister = !!sso.registrationEnabled;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError('请输入邮箱和密码'); return; }
    if (mode === 'register') {
      if (password.length < 6) { setError('密码至少 6 位'); return; }
      if (password !== password2) { setError('两次输入的密码不一致'); return; }
    }
    setBusy(true);
    try {
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register'
          ? { email: email.trim(), password, name: name.trim() || undefined }
          : { email: email.trim(), password }),
      });
      const d: any = await res.json().catch(() => null);
      if (!res.ok || !d?.success) {
        setError(d?.error || (mode === 'register' ? '注册失败' : '邮箱或密码错误'));
        return;
      }
      // 保存凭证（与 OIDC 回调页存储同位）
      localStorage.setItem('kqa.token', d.token);
      localStorage.setItem('kqa.refreshToken', d.refreshToken || '');
      if (d.user) localStorage.setItem('kqa.user', JSON.stringify(d.user));
      localStorage.setItem('kqa.roles', JSON.stringify(d.user?.roles || []));
      window.location.href = '/';
    } catch (err) {
      setError(`网络错误：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function onSso() {
    setRedirecting(true);
    window.location.href = sso.loginUrl || '/api/auth/oidc/login';
  }

  return (
    <div className="login-layout">
      {/* 左：品牌展示区（窄屏隐藏） */}
      <div className="login-showcase">
        <div className="login-brand">
          <div className="brand-mark">知</div>
          <h1>知识问答 Agent</h1>
          <p className="login-brand-sub">每条回答都标出处</p>
        </div>
        <div className="login-features">
          <div className="feature-item">
            <span className="feature-icon">溯源</span>
            <span className="feature-text">每个结论带 [n] 引用，点击直达原文行</span>
          </div>
          <div className="feature-item">
            <span className="feature-icon">混合检索</span>
            <span className="feature-text">BM25 词法 + bge-m3 向量双通道，RRF 融合精排</span>
          </div>
          <div className="feature-item">
            <span className="feature-icon">防幻觉</span>
            <span className="feature-text">检索无据直接拒答，绝不用模型记忆冒充知识库</span>
          </div>
        </div>
      </div>

      {/* 右：登录表单卡 */}
      <div className="login-panel">
        <div className="form-card">
          <div className="form-header">
            <div className="form-title">{mode === 'login' ? '登录' : '注册'}</div>
            <div className="form-welcome">
              {mode === 'login' ? '欢迎使用知识问答 Agent' : '创建一个新账号'}
            </div>
            {!required && <div className="form-hint">本系统登录为可选项，直接访问首页也可使用</div>}
          </div>
          <div className="form-content">
            {showLocal && (
              <form onSubmit={onSubmit} className="login-form">
                <Input
                  type="text"
                  placeholder="邮箱"
                  value={email}
                  onChange={(v: string) => setEmail(v)}
                  autocomplete="email"
                  status={error ? 'error' : undefined}
                />
                {mode === 'register' && (
                  <Input
                    placeholder="姓名（可选）"
                    value={name}
                    onChange={(v: string) => setName(v)}
                  />
                )}
                <Input
                  type="password"
                  placeholder="密码"
                  value={password}
                  onChange={(v: string) => setPassword(v)}
                  autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
                  status={error ? 'error' : undefined}
                />
                {mode === 'register' && (
                  <Input
                    type="password"
                    placeholder="确认密码"
                    value={password2}
                    onChange={(v: string) => setPassword2(v)}
                    autocomplete="new-password"
                    status={error ? 'error' : undefined}
                  />
                )}
                {error && <div className="login-error">{error}</div>}
                <Button
                  className="submit-button"
                  theme="primary"
                  size="large"
                  block
                  loading={busy}
                  disabled={busy}
                  type="submit"
                >{mode === 'login' ? '登录' : '注册'}</Button>
              </form>
            )}
            {showLocal && showSso && <div className="login-divider"><span>或</span></div>}
            {showSso && (
              <Button
                className="oidc-button"
                variant={showLocal ? 'outline' : 'base'}
                theme={showLocal ? 'default' : 'primary'}
                size="large"
                block
                loading={redirecting}
                disabled={redirecting}
                onClick={onSso}
              >{redirecting ? '正在跳转到 SSO…' : (sso.providerName || 'SSO 登录')}</Button>
            )}
          </div>
          <div className="form-footer">
            {showRegister ? (
              mode === 'login' ? (
                <span className="form-hint">
                  还没有账号？
                  <button className="link-button" onClick={() => { setMode('register'); setError(''); }}>注册</button>
                </span>
              ) : (
                <span className="form-hint">
                  已有账号？
                  <button className="link-button" onClick={() => { setMode('login'); setError(''); }}>登录</button>
                </span>
              )
            ) : (
              <span className="form-hint">
                {showSso && !showLocal ? '登录由企业统一身份认证（Keycloak）完成，本系统不保存密码' : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
